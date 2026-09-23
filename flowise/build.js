#!/usr/bin/env node
/**
 * Build every flow export from its node sources.
 *
 * The installer registers flowise/flows/*.json, but a person edits
 * flowise/nodes/*.js. Kept by hand, the two drifted: four exports had fallen
 * behind or been corrupted (a regex whose \b had become a backspace character,
 * a prompt log that never ran), and fifteen steps had no source at all. Now the
 * sources are the only copy anyone edits, and this writes the exports from them.
 *
 *   node flowise/build.js            rewrite any export that differs
 *   node flowise/build.js --check    change nothing; exit 1 listing what differs
 *
 * flows/_sources.json says which source file is which step:
 *   { "4-Panoramic-Generator": { "customFunctionAgentflow_0": "_pano_resolver_node.js", ... } }
 *
 * Shared code lives in flowise/lib/. A source line of exactly
 *   // @include llm
 * is replaced by flowise/lib/llm.js. A Flowise Custom Function cannot require a
 * file of its own - its sandbox allows Node built-ins and a few packages only -
 * so shared code has to be inlined into every flow that uses it. It is inlined
 * here, once, rather than pasted into each source by hand.
 */
'use strict'

const fs = require('fs')
const path = require('path')

const ROOT = __dirname
const LIB = path.join(ROOT, 'lib')
const NODES = path.join(ROOT, 'nodes')
const FLOWS = path.join(ROOT, 'flows')

const INCLUDE = /^[ \t]*\/\/ @include ([\w-]+)[ \t]*$/gm

function read(file) {
  return fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n')
}

/** Replace each `// @include name` line with flowise/lib/name.js, recursively. */
function expand(source, seen = []) {
  return source.replace(INCLUDE, (_, name) => {
    if (seen.includes(name)) throw new Error(`@include cycle: ${[...seen, name].join(' -> ')}`)
    const file = path.join(LIB, name + '.js')
    if (!fs.existsSync(file)) throw new Error(`@include ${name}: there is no flowise/lib/${name}.js`)
    const body = expand(read(file).trim(), [...seen, name])
    return (
      `// ---- ${name}: inlined from flowise/lib/${name}.js by flowise/build.js. Edit it there. ----\n` +
      `${body}\n` +
      `// ---- end ${name} ----`
    )
  })
}

/** A node source as it goes into Flowise. */
function buildSource(file) {
  return expand(read(path.isAbsolute(file) ? file : path.join(NODES, file))).trim()
}

function indentOf(raw) {
  if (raw.startsWith('{\n    ')) return 4
  if (raw.startsWith('{\n  ')) return 2
  return undefined
}

function main() {
  const check = process.argv.includes('--check')
  const manifest = JSON.parse(read(path.join(FLOWS, '_sources.json')))
  const differs = []
  const problems = []

  for (const [flow, steps] of Object.entries(manifest)) {
    const file = path.join(FLOWS, flow + '.json')
    if (!fs.existsSync(file)) {
      problems.push(`${flow}: no export at flows/${flow}.json`)
      continue
    }
    const raw = fs.readFileSync(file, 'utf8')
    const graph = JSON.parse(raw)
    let changed = false
    for (const [nodeId, source] of Object.entries(steps)) {
      const node = (graph.nodes || []).find((n) => n.id === nodeId)
      const inputs = node && node.data && node.data.inputs
      if (!inputs || typeof inputs.customFunctionJavascriptFunction !== 'string') {
        problems.push(`${flow}: no code step ${nodeId}`)
        continue
      }
      let built
      try {
        built = buildSource(source)
      } catch (e) {
        problems.push(`${flow}/${nodeId} (${source}): ${e.message}`)
        continue
      }
      const current = inputs.customFunctionJavascriptFunction.replace(/\r\n/g, '\n').trim()
      if (current !== built) {
        differs.push(`${flow}/${nodeId} <- ${source}`)
        inputs.customFunctionJavascriptFunction = built
        changed = true
      }
    }
    if (changed && !check) {
      fs.writeFileSync(file, JSON.stringify(graph, null, indentOf(raw)) + (raw.endsWith('\n') ? '\n' : ''))
    }
  }

  // Every code step in every export must be accounted for, or a new step could
  // be added in the Flowise UI and exported without ever getting a source.
  for (const file of fs.readdirSync(FLOWS)) {
    if (!file.endsWith('.json') || file.startsWith('_')) continue
    const flow = file.slice(0, -5)
    const graph = JSON.parse(fs.readFileSync(path.join(FLOWS, file), 'utf8'))
    for (const node of graph.nodes || []) {
      const code = node.data && node.data.inputs && node.data.inputs.customFunctionJavascriptFunction
      if (typeof code === 'string' && !(manifest[flow] && manifest[flow][node.id])) {
        problems.push(`${flow}/${node.id}: a code step with no source in flows/_sources.json`)
      }
    }
  }

  for (const p of problems) console.error('problem: ' + p)
  if (check) {
    for (const d of differs) console.error('out of date: ' + d)
    if (differs.length || problems.length) {
      console.error(`\n${differs.length} step(s) out of date. Run: node flowise/build.js`)
      process.exit(1)
    }
    console.log('flow exports match their sources')
    return
  }
  for (const d of differs) console.log('built ' + d)
  console.log(`${differs.length} step(s) rebuilt`)
  if (problems.length) process.exit(1)
}

module.exports = { expand, buildSource }

if (require.main === module) main()
