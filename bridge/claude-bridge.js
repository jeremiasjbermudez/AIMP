#!/usr/bin/env node
/**
 * Claude, through the Claude Code CLI, as a language model the flows can call.
 *
 * Every flow reaches its model through one of two doors: the shim inside a
 * Custom Function (Ollama or OpenAI-compatible, chosen in the app's model
 * picker) or Flowise's own ChatOllama node (Beat and Character Generator). This
 * answers both - OpenAI's /v1/chat/completions and Ollama's /api/chat - by
 * running `claude -p`, so using Claude is a profile in the picker rather than a
 * change to twelve copies of the shim.
 *
 * It uses whatever the CLI is signed in as. No API key passes through here.
 *
 * Each call is a clean, tool-less session: no built-in tools, no MCP servers,
 * no user settings or hooks, no CLAUDE.md (it runs in the temp folder), nothing
 * saved. A flow asks for text and gets text; it cannot make the CLI act.
 *
 *   node bridge/claude-bridge.js              # 127.0.0.1:11435
 *   CLAUDE_BRIDGE_PORT=11500 node bridge/claude-bridge.js
 *
 * Model names: the CLI's aliases (sonnet, opus, haiku, fable) or a full id.
 * Anything else - a leftover Ollama name such as qwen3:8b - uses the default.
 */
'use strict'

const http = require('http')
const os = require('os')
const { spawn } = require('child_process')

const PORT = Number(process.env.CLAUDE_BRIDGE_PORT || 11435)
// Loopback only: Flowise runs on this machine, and nothing else should be able
// to spend this account's usage.
const HOST = process.env.CLAUDE_BRIDGE_HOST || '127.0.0.1'
const CLAUDE = process.env.CLAUDE_BIN || 'claude'
const DEFAULT_MODEL = process.env.CLAUDE_BRIDGE_MODEL || 'sonnet'
// Each call is a CLI process. A flow that fans out should queue here rather
// than start twenty of them at once.
const MAX_PARALLEL = Number(process.env.CLAUDE_BRIDGE_PARALLEL || 3)
const TIMEOUT_MS = Number(process.env.CLAUDE_BRIDGE_TIMEOUT_MS || 10 * 60 * 1000)

const MODELS = ['sonnet', 'opus', 'haiku', 'fable']

function log(...args) {
  console.log(new Date().toISOString(), ...args)
}

// ---------------------------------------------------------------- the queue
let running = 0
const waiting = []
function slot() {
  if (running < MAX_PARALLEL) {
    running++
    return Promise.resolve()
  }
  return new Promise((resolve) => waiting.push(resolve))
}
function release() {
  const next = waiting.shift()
  if (next) next()
  else running--
}

// ---------------------------------------------------------------- the call
function modelFor(name) {
  const n = String(name || '').trim()
  if (MODELS.includes(n.toLowerCase())) return n.toLowerCase()
  if (/^claude-/.test(n)) return n
  return DEFAULT_MODEL
}

function mediaType(b64) {
  const head = Buffer.from(String(b64).slice(0, 16), 'base64')
  if (head[0] === 0x89 && head[1] === 0x50) return 'image/png'
  if (head[0] === 0xff && head[1] === 0xd8) return 'image/jpeg'
  if (head.slice(0, 4).toString() === 'GIF8') return 'image/gif'
  if (head.slice(8, 12).toString() === 'WEBP') return 'image/webp'
  return 'image/png'
}

/**
 * Normalise either API's messages into { system, blocks }: one system prompt,
 * and the content of the single user turn the CLI is given.
 *
 * The CLI cannot be handed prior assistant turns, so a conversation is written
 * out as a transcript above the last message. Every flow here sends a system
 * prompt and one user message, so this is the rare path.
 */
function toPrompt(messages) {
  const system = []
  const turns = []
  for (const m of messages || []) {
    const text = []
    const images = []
    if (typeof m.content === 'string') text.push(m.content)
    else if (Array.isArray(m.content)) {
      for (const part of m.content) {
        if (part.type === 'text') text.push(part.text)
        else if (part.type === 'image_url') {
          const url = typeof part.image_url === 'string' ? part.image_url : (part.image_url || {}).url
          const match = /^data:([^;]+);base64,(.*)$/.exec(url || '')
          if (match) images.push({ type: match[1], data: match[2] })
        }
      }
    }
    for (const b64 of m.images || []) images.push({ type: mediaType(b64), data: b64 })
    if (m.role === 'system') system.push(text.join('\n'))
    else turns.push({ role: m.role, text: text.join('\n'), images })
  }

  const last = turns.pop() || { text: '', images: [] }
  let body = last.text
  if (turns.length) {
    const history = turns
      .map((t) => `${t.role === 'assistant' ? 'Assistant' : 'User'}: ${t.text}`)
      .join('\n\n')
    body = `The conversation so far:\n\n${history}\n\nRespond to the latest message:\n\n${last.text}`
  }
  const blocks = []
  for (const img of turns.flatMap((t) => t.images).concat(last.images)) {
    blocks.push({ type: 'image', source: { type: 'base64', media_type: img.type, data: img.data } })
  }
  blocks.push({ type: 'text', text: body || '(empty)' })
  return { system: system.join('\n\n'), blocks }
}

/** What to add to the system prompt when the caller wants JSON or a tool call. */
function shapeInstruction({ json, schema, tools }) {
  if (tools && tools.length) {
    const list = tools.map((t) => {
      const f = t.function || t
      return `- ${f.name}: ${f.description || ''}\n  arguments JSON schema: ${JSON.stringify(f.parameters || {})}`
    })
    return (
      'Answer by calling exactly one of these tools. Reply with ONLY a JSON object ' +
      '{"name": "<tool name>", "arguments": { ... }} - no prose, no code fences.\n' + list.join('\n')
    )
  }
  if (schema) {
    return 'Reply with ONLY a JSON value matching this JSON schema - no prose, no code fences:\n' + JSON.stringify(schema)
  }
  if (json) return 'Reply with ONLY valid JSON - no prose, no code fences.'
  return ''
}

/** The JSON inside a reply, with any code fence or stray prose around it removed. */
function extractJson(text) {
  const t = String(text).trim()
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(t)
  const candidate = fence ? fence[1].trim() : t
  try {
    JSON.parse(candidate)
    return candidate
  } catch (e) {
    const start = candidate.search(/[[{]/)
    const end = Math.max(candidate.lastIndexOf('}'), candidate.lastIndexOf(']'))
    if (start >= 0 && end > start) {
      const inner = candidate.slice(start, end + 1)
      try {
        JSON.parse(inner)
        return inner
      } catch (e2) { /* fall through */ }
    }
    return candidate
  }
}

async function runClaude({ model, system, blocks }) {
  await slot()
  const started = Date.now()
  try {
    return await new Promise((resolve, reject) => {
      const args = [
        '-p',
        '--input-format', 'stream-json',
        '--output-format', 'stream-json',
        '--verbose',
        '--model', model,
        '--tools', '',
        '--strict-mcp-config',
        '--setting-sources', '',
        '--no-session-persistence',
        '--disable-slash-commands',
        '--system-prompt', system || 'You are a helpful assistant.'
      ]
      // With ANTHROPIC_API_KEY set, the CLI bills that API key rather than the
      // subscription it is signed in with - silently, per call. This bridge is
      // for the subscription, so the key is never passed on.
      const env = { ...process.env }
      delete env.ANTHROPIC_API_KEY
      const child = spawn(CLAUDE, args, { cwd: os.tmpdir(), env, stdio: ['pipe', 'pipe', 'pipe'] })
      let out = ''
      let err = ''
      const timer = setTimeout(() => {
        child.kill('SIGKILL')
        reject(new Error(`claude did not answer within ${TIMEOUT_MS / 1000}s`))
      }, TIMEOUT_MS)
      child.stdout.on('data', (d) => (out += d))
      child.stderr.on('data', (d) => (err += d))
      child.on('error', (e) => {
        clearTimeout(timer)
        reject(new Error(`could not run ${CLAUDE}: ${e.message}`))
      })
      child.on('close', (code) => {
        clearTimeout(timer)
        let result = null
        for (const line of out.split('\n')) {
          if (!line.trim()) continue
          try {
            const msg = JSON.parse(line)
            if (msg.type === 'result') result = msg
          } catch (e) { /* not JSON: ignore */ }
        }
        if (!result) return reject(new Error(`claude exited ${code} with no result. ${err.trim().slice(-500)}`))
        if (result.is_error || result.subtype !== 'success') {
          return reject(new Error(`claude: ${result.result || result.subtype}`))
        }
        resolve({ text: String(result.result || ''), usage: result.usage || {} })
      })
      child.stdin.end(JSON.stringify({ type: 'user', message: { role: 'user', content: blocks } }) + '\n')
    })
  } finally {
    release()
    log(`${model} ${Date.now() - started}ms`)
  }
}

/** One completion in a neutral shape: { content, toolCall }. */
async function complete({ model, messages, json, schema, tools }) {
  const { system, blocks } = toPrompt(messages)
  const extra = shapeInstruction({ json, schema, tools })
  const { text, usage } = await runClaude({
    model: modelFor(model),
    system: [system, extra].filter(Boolean).join('\n\n'),
    blocks
  })
  if (tools && tools.length) {
    try {
      const call = JSON.parse(extractJson(text))
      if (call && call.name) return { content: '', toolCall: { name: call.name, arguments: call.arguments || {} }, usage }
    } catch (e) { /* not a tool call after all: return it as text */ }
  }
  return { content: json || schema ? extractJson(text) : text, usage }
}

// ---------------------------------------------------------------- HTTP
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = ''
    req.on('data', (c) => (data += c))
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {})
      } catch (e) {
        reject(new Error('request body is not JSON'))
      }
    })
    req.on('error', reject)
  })
}

function send(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body))
}

async function openaiChat(req, res) {
  const body = await readBody(req)
  const rf = body.response_format || {}
  const out = await complete({
    model: body.model,
    messages: body.messages,
    json: rf.type === 'json_object',
    schema: rf.type === 'json_schema' ? (rf.json_schema || {}).schema : null,
    tools: body.tools
  })
  const message = { role: 'assistant', content: out.content }
  if (out.toolCall) {
    message.content = null
    message.tool_calls = [{
      id: 'call_' + Date.now(),
      type: 'function',
      function: { name: out.toolCall.name, arguments: JSON.stringify(out.toolCall.arguments) }
    }]
  }
  const reply = {
    id: 'chatcmpl-' + Date.now(),
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: modelFor(body.model),
    choices: [{ index: 0, message, finish_reason: out.toolCall ? 'tool_calls' : 'stop' }],
    usage: {
      prompt_tokens: out.usage.input_tokens || 0,
      completion_tokens: out.usage.output_tokens || 0,
      total_tokens: (out.usage.input_tokens || 0) + (out.usage.output_tokens || 0)
    }
  }
  if (!body.stream) return send(res, 200, reply)
  // Streaming asked for: the whole answer as one chunk, then the end marker.
  res.writeHead(200, { 'Content-Type': 'text/event-stream' })
  const delta = Object.assign({ role: 'assistant' }, message)
  res.write('data: ' + JSON.stringify({
    id: reply.id, object: 'chat.completion.chunk', created: reply.created, model: reply.model,
    choices: [{ index: 0, delta, finish_reason: reply.choices[0].finish_reason }]
  }) + '\n\n')
  res.end('data: [DONE]\n\n')
}

async function ollamaChat(req, res) {
  const body = await readBody(req)
  const format = body.format
  const out = await complete({
    model: body.model,
    messages: body.messages,
    json: format === 'json',
    schema: format && typeof format === 'object' ? format : null,
    tools: body.tools
  })
  const message = { role: 'assistant', content: out.content }
  if (out.toolCall) message.tool_calls = [{ function: out.toolCall }]
  const done = {
    model: body.model || modelFor(body.model),
    created_at: new Date().toISOString(),
    message,
    done: true,
    done_reason: 'stop',
    prompt_eval_count: out.usage.input_tokens || 0,
    eval_count: out.usage.output_tokens || 0
  }
  // Ollama streams unless told not to, and its clients expect NDJSON when it does.
  if (body.stream === false) return send(res, 200, done)
  res.writeHead(200, { 'Content-Type': 'application/x-ndjson' })
  res.write(JSON.stringify(Object.assign({}, done, { done: false, done_reason: undefined })) + '\n')
  res.end(JSON.stringify(Object.assign({}, done, { message: { role: 'assistant', content: '' } })) + '\n')
}

const server = http.createServer(async (req, res) => {
  const url = (req.url || '').split('?')[0]
  try {
    if (req.method === 'GET' && (url === '/' || url === '/health')) return send(res, 200, { ok: true, bridge: 'claude-cli' })
    if (req.method === 'GET' && url === '/v1/models') {
      return send(res, 200, { object: 'list', data: MODELS.map((id) => ({ id, object: 'model', owned_by: 'anthropic' })) })
    }
    if (req.method === 'GET' && url === '/api/tags') {
      return send(res, 200, { models: MODELS.map((name) => ({ name, model: name })) })
    }
    if (req.method === 'POST' && url === '/v1/chat/completions') return await openaiChat(req, res)
    if (req.method === 'POST' && url === '/api/chat') return await ollamaChat(req, res)
    send(res, 404, { error: `no route ${req.method} ${url}` })
  } catch (e) {
    log('error', e.message)
    if (!res.headersSent) send(res, 500, { error: { message: e.message } })
    else res.end()
  }
})

server.listen(PORT, HOST, () => {
  log(`claude bridge on http://${HOST}:${PORT} (default model ${DEFAULT_MODEL})`)
  if (process.env.ANTHROPIC_API_KEY) {
    log('ANTHROPIC_API_KEY is set here; it is not passed to claude, which uses its own sign-in')
  }
})
