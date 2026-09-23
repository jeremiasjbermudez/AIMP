/**
 * Register one Flowise flow from a node source file.
 *
 * Every flow in this system has the same shape: a Start node feeding a single
 * Custom Function node whose body is a file from flowise/nodes/. That made the
 * per-flow creator scripts almost identical, and almost-identical scripts drift.
 * This is the one that remains; a module names its node files and the installer
 * calls this for each.
 *
 * Usage:
 *   node create-flow.js --name 4-Panoramic-Generator --source ../../flowise/nodes/_x.js
 *                       [--label "Human label"] [--update <flowId>]
 *
 * Reads its connection settings from the environment, so nothing is hardcoded:
 *   FLOWISE_URL, FLOWISE_API_KEY, INSFORGE_URL, INSFORGE_API_KEY,
 *   COMFY_URL, COMFY_ROOT, and optionally OLLAMA_URL, OLLAMA_MODEL
 *
 * Prints the flow id on the last line, which is what the installer captures.
 */
const fs = require('fs')
const path = require('path')
// The sources are the only copy anyone edits: flowise/build.js inlines their
// shared code (`// @include llm`) and knows which source is which step.
const { buildSource } = require('../../flowise/build.js')
const SOURCES_MANIFEST = path.join(__dirname, '../../flowise/flows/_sources.json')

function arg(name, fallback) {
  const i = process.argv.indexOf('--' + name)
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}

const NAME = arg('name')
const SOURCE = arg('source')
const LABEL = arg('label', NAME)
const UPDATE = arg('update', process.env.UPDATE_ID || '')

if (!NAME || !SOURCE) {
  console.error('need --name and --source')
  process.exit(2)
}

const REQUIRED = ['FLOWISE_URL', 'FLOWISE_API_KEY', 'INSFORGE_URL', 'INSFORGE_API_KEY', 'COMFY_URL', 'COMFY_ROOT']
const missing = REQUIRED.filter((k) => !process.env[k])
if (missing.length) {
  console.error('these environment variables are not set: ' + missing.join(', '))
  process.exit(2)
}

const BASE = process.env.FLOWISE_URL.replace(/\/$/, '')

// The language model this install uses, for Flowise's own LLM nodes as well as
// for the flows that call it from code.
const LLM_PROVIDER = (process.env.LLM_PROVIDER || 'ollama').toLowerCase()
const LLM_URL = (process.env.LLM_URL || process.env.OLLAMA_URL || '').replace(/\/$/, '')
const LLM_MODEL = process.env.LLM_MODEL || process.env.OLLAMA_MODEL || ''
const HEADERS = { Authorization: 'Bearer ' + process.env.FLOWISE_API_KEY }

// The flow's variables. Every flow gets the same four; the two Ollama ones are
// added only when set, because a flow that does not call a language model has
// no use for them and an empty value would read as a misconfiguration.
const VARIABLES = [
  { variableName: 'insforgeUrl', variableValue: process.env.INSFORGE_URL },
  { variableName: 'insforgeApiKey', variableValue: process.env.INSFORGE_API_KEY },
  { variableName: 'comfyUrl', variableValue: process.env.COMFY_URL },
  { variableName: 'comfyRoot', variableValue: process.env.COMFY_ROOT },
  // For a flow that runs another flow itself (Wardrobe runs Image-Edit): where
  // Flowise is, and the key to call it with, rather than localhost:3010.
  { variableName: 'flowiseUrl', variableValue: BASE },
  { variableName: 'flowiseApiKey', variableValue: process.env.FLOWISE_API_KEY },
  // The render host's worker (pc-worker/), for work that has to happen on that
  // machine - starting the on-demand world ComfyUI. Blank when there is none.
  { variableName: 'workerUrl', variableValue: process.env.WORKER_URL || '' },
  // ComfyUI's own Python, for the flows that run a script with it on this
  // machine (flowise/workers/: Face QA). Blank means `python` on PATH.
  { variableName: 'comfyPython', variableValue: process.env.COMFY_PYTHON || '' },
  { variableName: 'workerToken', variableValue: process.env.WORKER_TOKEN || '' }
]
// The language-model settings go on EVERY flow, always, even when blank.
// Injecting them only when an Ollama URL happened to be set is what produced
// "$ollamaUrl is not defined" on an install that skipped Ollama: the flow
// referenced a variable that was never declared, and it failed at run time
// rather than at install time. A blank value gives a flow that says what is
// unconfigured; a missing one gives a stack trace.
VARIABLES.push({ variableName: 'llmProvider', variableValue: process.env.LLM_PROVIDER || 'ollama' })
VARIABLES.push({ variableName: 'llmUrl', variableValue: process.env.LLM_URL || process.env.OLLAMA_URL || '' })
VARIABLES.push({ variableName: 'llmModel', variableValue: process.env.LLM_MODEL || process.env.OLLAMA_MODEL || '' })
VARIABLES.push({ variableName: 'llmApiKey', variableValue: process.env.LLM_API_KEY || '' })
// The old names, for any flow not yet migrated to the shim. ollamaBaseUrl is
// the same address again under a third name, used by two older flows: the
// export blanks it as per-install, so it has to be set here or the guard below
// refuses the flow - which is how this one was found.
VARIABLES.push({ variableName: 'ollamaUrl', variableValue: process.env.LLM_URL || process.env.OLLAMA_URL || '' })
VARIABLES.push({ variableName: 'ollamaBaseUrl', variableValue: process.env.LLM_URL || process.env.OLLAMA_URL || '' })
// Where the installer lives, so the settings page can run it. Only the flow
// that installs modules uses it; the others ignore it.
VARIABLES.push({ variableName: 'installRoot', variableValue: process.env.INSTALL_ROOT || '' })
VARIABLES.push({ variableName: 'ollamaModel', variableValue: process.env.LLM_MODEL || process.env.OLLAMA_MODEL || '' })

async function main() {
  // A flow's exported graph is what gets installed whenever there is one. Seven
  // flows are not a single function - a resolver feeding a worker, four nodes
  // in one case - and building those from one node file produced a flow missing
  // half its graph. The export also carries each flow's own variables: the
  // writer's system prompt, the kind that separates image-to-video from
  // text-to-video, the output names a resolver passes downstream. Rebuilding
  // from a source file loses all of it.
  if (SOURCE.endsWith('.json')) return importExported()

  const body = buildSource(path.resolve(SOURCE))

  // The node definitions are fetched rather than hardcoded: their input schema
  // changes between Flowise versions, and a stale copy produces a flow that
  // looks right in the list and fails the moment it runs.
  const fnSchema = await get('/api/v1/nodes/customFunctionAgentflow')
  const startSchema = await get('/api/v1/nodes/startAgentflow')

  const startNode = {
    id: 'startAgentflow_0',
    position: { x: 0, y: 0 },
    type: 'agentFlow',
    data: {
      id: 'startAgentflow_0', label: 'Start', version: 1.4, name: 'startAgentflow', type: 'Start',
      color: '#7EE787', hideInput: true, baseClasses: ['Start'], category: 'Agent Flows',
      description: 'Starting point of the agentflow', inputParams: startSchema.inputs, inputAnchors: [],
      inputs: { startInputType: 'chatInput' }, outputAnchors: [], outputs: {}, selected: false
    },
    width: 300, height: 100, selected: false, positionAbsolute: { x: 0, y: 0 }, dragging: false
  }

  const id = 'customFunctionAgentflow_0'
  const fnNode = {
    id, position: { x: 300, y: 0 }, type: 'agentFlow',
    data: {
      id, label: LABEL, version: 1.1, name: 'customFunctionAgentflow', type: 'CustomFunction',
      color: '#E4B7FF', baseClasses: ['CustomFunction'], category: 'Agent Flows',
      description: 'Execute custom function', inputParams: fnSchema.inputs, inputAnchors: [],
      inputs: { customFunctionInputVariables: VARIABLES, customFunctionJavascriptFunction: body },
      outputAnchors: [], outputs: {}, selected: false
    },
    width: 300, height: 100, selected: false, positionAbsolute: { x: 300, y: 0 }, dragging: false
  }

  const flowDataRaw = JSON.stringify({
    nodes: [startNode, fnNode],
    edges: [{
      source: 'startAgentflow_0', sourceHandle: 'startAgentflow_0-output-startAgentflow',
      target: id, targetHandle: id + '-input-customFunction',
      type: 'agentFlow', id: 'startAgentflow_0-' + id
    }],
    viewport: { x: 0, y: 0, zoom: 0.6 }
  })

  if (UPDATE) {
    const flowData = await resolveFlowRefs(flowDataRaw)
    await send('PUT', '/api/v1/chatflows/' + UPDATE, { flowData })
    console.log('updated ' + NAME)
    console.log(UPDATE)
    return
  }

  const flowData = await resolveFlowRefs(flowDataRaw)
  // A second flow with the same name would be indistinguishable in the list and
  // would leave the installer unsure which id to record, so an existing one is
  // updated in place instead.
  const existing = (await get('/api/v1/chatflows')).find((f) => f.name === NAME)
  if (existing) {
    await send('PUT', '/api/v1/chatflows/' + existing.id, { flowData })
    console.log('updated existing ' + NAME)
    console.log(existing.id)
    return
  }

  const made = await send('POST', '/api/v1/chatflows', {
    name: NAME, type: 'AGENTFLOW', flowData, deployed: true
  })
  console.log('created ' + NAME)
  console.log(made.id)
}

/** Register a flow from an exported graph, rewriting its per-install variables. */
async function importExported() {
  const graph = JSON.parse(fs.readFileSync(path.resolve(SOURCE), 'utf8'))
  // Each code step is rebuilt from its source here, not taken from the export
  // as committed, so a source edited without re-running flowise/build.js still
  // installs what the source says.
  const steps = (JSON.parse(fs.readFileSync(SOURCES_MANIFEST, 'utf8')) || {})[NAME] || {}
  for (const node of graph.nodes || []) {
    const inputs = (node.data || {}).inputs
    if (steps[node.id] && inputs && typeof inputs.customFunctionJavascriptFunction === 'string') {
      inputs.customFunctionJavascriptFunction = buildSource(steps[node.id])
    }
  }
  for (const node of graph.nodes || []) {
    const inputs = (node.data || {}).inputs
    if (!inputs) continue
    if (Array.isArray(inputs.customFunctionInputVariables)) {
      // Keep any variable this flow declares that is not one of ours, so a
      // flow with its own extra setting is not silently stripped of it.
      const mine = new Map(VARIABLES.map((v) => [v.variableName, v.variableValue]))
      inputs.customFunctionInputVariables = inputs.customFunctionInputVariables.map((v) =>
        mine.has(v.variableName) ? { ...v, variableValue: mine.get(v.variableName) } : v
      )
      for (const v of VARIABLES) {
        if (!inputs.customFunctionInputVariables.some((x) => x.variableName === v.variableName)) {
          inputs.customFunctionInputVariables.push(v)
        }
      }
    }
  }
  // Flowise's own LLM node keeps its address in llmModelConfig, not in a
  // function variable, so filling only the variables left it pointing at the
  // export's placeholder. Two flows use one.
  for (const node of graph.nodes || []) {
    if ((node.data || {}).name !== 'llmAgentflow') continue
    const cfg = (node.data.inputs || {}).llmModelConfig
    if (!cfg || typeof cfg !== 'object') continue
    if (LLM_URL) cfg.baseUrl = LLM_URL
    if (LLM_MODEL) cfg.modelName = LLM_MODEL
    if (LLM_PROVIDER !== 'ollama') {
      // The node is bound to a specific provider component, so pointing it at
      // an OpenAI-compatible API would not work even with the right URL.
      console.error(`${NAME}: this flow uses Flowise's ${node.data.inputs.llmModel || 'LLM'} node, ` +
        `which talks to Ollama. This install is set to '${LLM_PROVIDER}'. ` +
        'Install it against an Ollama, or edit that node in the Flowise UI.')
      process.exit(1)
    }
  }

  // Nothing may still carry a placeholder. The export blanks per-install values
  // and the scrubber replaces secrets and addresses; either surviving here
  // means a field this installer does not know how to fill, and the flow would
  // fail at run time somewhere far from the cause.
  const PLACEHOLDER = /<set at install time>|<lan-host>|<REDACTED>|<INSFORGE_API_KEY>|<API_KEY>|<TOKEN>|<email>|<OPENROUTER_API_KEY>|<ANTHROPIC_API_KEY>/
  const left = []
  for (const node of graph.nodes || []) {
    const inputs = (node.data || {}).inputs || {}
    for (const [key, value] of Object.entries(inputs)) {
      const text = typeof value === 'string' ? value : JSON.stringify(value)
      if (text && PLACEHOLDER.test(text)) left.push(`${node.id}.${key}`)
    }
  }
  if (left.length) {
    console.error(`${NAME}: still unfilled after install: ${[...new Set(left)].join(', ')}. ` +
      'Teach create-flow.js to set it, or add it to install.env.')
    process.exit(1)
  }

  const flowData = await resolveFlowRefs(JSON.stringify(graph))
  const existing = (await get('/api/v1/chatflows')).find((f) => f.name === NAME)
  if (existing) {
    await send('PUT', '/api/v1/chatflows/' + existing.id, { flowData })
    console.log('updated existing ' + NAME + ' (from export)')
    console.log(existing.id)
    return
  }
  const made = await send('POST', '/api/v1/chatflows', { name: NAME, type: 'AGENTFLOW', flowData, deployed: true })
  console.log('created ' + NAME + ' (from export)')
  console.log(made.id)
}

/**
 * Replace every {{flow:NAME}} with the id that flow has on THIS install.
 *
 * A flow that runs another one used to carry the other's id from the machine it
 * was exported on, so on any other install it ran nothing (the orchestrator) or
 * fell back to a stranger's id (Wardrobe). Flows are referred to by name
 * instead, and a name that is not installed stops the install here, saying
 * which, rather than failing the first time the flow runs.
 */
async function resolveFlowRefs(text) {
  const names = [...new Set([...text.matchAll(/\{\{flow:([\w.-]+)\}\}/g)].map((m) => m[1]))]
  if (!names.length) return text
  const byName = new Map((await get('/api/v1/chatflows')).map((f) => [f.name, f.id]))
  const missing = names.filter((n) => !byName.has(n))
  if (missing.length) {
    throw new Error(`${NAME} runs ${missing.join(', ')}, which is not installed. ` +
      'Install the module that owns it first.')
  }
  return text.replace(/\{\{flow:([\w.-]+)\}\}/g, (_, n) => byName.get(n))
}

async function get(route) {
  const res = await fetch(BASE + route, { headers: HEADERS })
  if (!res.ok) throw new Error(`GET ${route} -> ${res.status} ${await res.text()}`)
  return res.json()
}

async function send(method, route, payload) {
  const res = await fetch(BASE + route, {
    method, headers: { ...HEADERS, 'Content-Type': 'application/json' }, body: JSON.stringify(payload)
  })
  if (!res.ok) throw new Error(`${method} ${route} -> ${res.status} ${(await res.text()).slice(0, 400)}`)
  return res.json()
}

main().catch((e) => {
  console.error(e.message)
  process.exit(1)
})
