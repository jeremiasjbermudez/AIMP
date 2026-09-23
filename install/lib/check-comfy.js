#!/usr/bin/env node
/**
 * Ask the running ComfyUI whether it has every node type a module's flows use.
 *
 *   node install/lib/check-comfy.js --module world [--module imaging ...] [--json]
 *   node install/lib/check-comfy.js --all
 *
 * Reads COMFY_URL from the environment (install.env). It asks ComfyUI over HTTP
 * rather than looking in its custom_nodes folder, so it works when ComfyUI is on
 * another machine - and it asks about node TYPES, which is what a graph needs.
 * A pack folder can be present and still register nothing, when its Python
 * requirements are missing.
 *
 * The node types are read from each flow's built source, as every
 * `class_type: '...'` literal. A graph that computes a class name at run time
 * is not seen, which in this repository is none of them.
 *
 * Exits 1 when anything is missing, 2 when ComfyUI cannot be reached.
 */
'use strict'

const fs = require('fs')
const path = require('path')

const REPO = path.resolve(__dirname, '../..')
const { buildSource } = require(path.join(REPO, 'flowise/build.js'))
const modules = JSON.parse(fs.readFileSync(path.join(REPO, 'install/modules.json'), 'utf8'))
const sources = JSON.parse(fs.readFileSync(path.join(REPO, 'flowise/flows/_sources.json'), 'utf8'))

const wanted = []
process.argv.forEach((a, i) => {
  if (a === '--module' && process.argv[i + 1]) wanted.push(process.argv[i + 1])
})
const all = process.argv.includes('--all')
const asJson = process.argv.includes('--json')
const names = all ? Object.keys(modules).filter((k) => !k.startsWith('$')) : wanted
if (!names.length) {
  console.error('name a module with --module, or pass --all')
  process.exit(2)
}

/** Every node type named in one flow's code, from its steps' sources. */
function nodeTypesOf(flow) {
  const files = sources[flow.name] ? Object.values(sources[flow.name]) : flow.source ? [flow.source] : []
  const types = new Set()
  for (const file of files) {
    let code
    try {
      code = buildSource(file)
    } catch (e) {
      continue
    }
    for (const m of code.matchAll(/class_type:\s*['"]([^'"]+)['"]/g)) types.add(m[1])
  }
  return types
}

;(async () => {
  const base = String(process.env.COMFY_URL || '').replace(/\/$/, '')
  if (!base) {
    console.error('COMFY_URL is not set')
    process.exit(2)
  }
  let known
  try {
    const res = await fetch(base + '/object_info', { signal: AbortSignal.timeout(30000) })
    if (!res.ok) throw new Error('HTTP ' + res.status)
    known = new Set(Object.keys(await res.json()))
  } catch (e) {
    console.error(`ComfyUI at ${base} did not answer: ${e.message}`)
    process.exit(2)
  }

  const report = {}
  for (const name of names) {
    const m = modules[name]
    if (!m) {
      report[name] = { error: 'no such module' }
      continue
    }
    const missing = {}
    for (const flow of m.flows || []) {
      for (const type of nodeTypesOf(flow)) {
        if (!known.has(type)) (missing[type] = missing[type] || []).push(flow.name)
      }
    }
    report[name] = { missing, packs: m.packs || [] }
  }

  if (asJson) {
    console.log(JSON.stringify(report))
  } else {
    for (const [name, r] of Object.entries(report)) {
      if (r.error) {
        console.log(`${name}: ${r.error}`)
        continue
      }
      const types = Object.keys(r.missing)
      if (!types.length) {
        console.log(`${name}: ComfyUI has every node type its flows use`)
        continue
      }
      console.log(`${name}: ComfyUI is missing ${types.length} node type(s):`)
      for (const t of types) console.log(`  ${t.padEnd(40)} used by ${[...new Set(r.missing[t])].join(', ')}`)
      if (r.packs.length) console.log(`  the module's node packs: ${r.packs.join(', ')}`)
    }
  }
  process.exit(Object.values(report).some((r) => r.error || Object.keys(r.missing || {}).length) ? 1 : 0)
})()
