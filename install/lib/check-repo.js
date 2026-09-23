#!/usr/bin/env node
/**
 * Check the repository is consistent with itself. No network, no GPU, no
 * install - so it runs in CI on every push.
 *
 *   node install/lib/check-repo.js
 *
 * What it catches is what has actually broken installs here:
 * - a flow step that does not parse, which Flowise only reports when it runs;
 * - modules.json naming a flow, panel, pack, model or dependency that does
 *   not exist, which only surfaces when someone installs that module;
 * - tabs.json pointing at a panel file that is not there;
 * - a node pack or model named in modules.json with no source in assets.json,
 *   so fetch-assets cannot get it;
 * - a pack with no pinned version, which is how an upstream release broke the
 *   panorama graph without a line of this repository changing.
 *
 * Exits 1 listing every problem, not just the first.
 */
'use strict'

const fs = require('fs')
const path = require('path')
const vm = require('vm')

const REPO = path.resolve(__dirname, '../..')
const at = (...p) => path.join(REPO, ...p)
const readJson = (...p) => JSON.parse(fs.readFileSync(at(...p), 'utf8'))
const problems = []
const warn = []
const fail = (msg) => problems.push(msg)

// ---------------------------------------------------------------- flow steps
const { buildSource } = require(at('flowise/build.js'))
const sources = readJson('flowise/flows/_sources.json')
const files = new Set(Object.values(sources).flatMap((steps) => Object.values(steps)))
for (const file of fs.readdirSync(at('flowise/nodes'))) if (file.endsWith('.js')) files.add(file)
let parsed = 0
for (const file of files) {
  let code
  try {
    code = buildSource(file)
  } catch (e) {
    fail(`flowise/nodes/${file}: ${e.message}`)
    continue
  }
  try {
    // Flowise runs a step as the body of an async function, so that is how it
    // is parsed here: top-level await and a bare return are both legal.
    new vm.Script('(async function () {\n' + code + '\n})', { filename: file })
    parsed++
  } catch (e) {
    fail(`flowise/nodes/${file}: does not parse - ${e.message}`)
  }
}

// ---------------------------------------------------------------- modules
const modules = readJson('install/modules.json')
const assets = readJson('install/assets.json')
const names = Object.keys(modules).filter((k) => !k.startsWith('$'))
for (const name of names) {
  const m = modules[name]
  for (const dep of [...(m.needs || []), ...(m.optional || [])]) {
    if (!modules[dep]) fail(`modules.json ${name}: depends on '${dep}', which is not a module`)
  }
  for (const flow of m.flows || []) {
    const exported = fs.existsSync(at('flowise/flows', flow.name + '.json'))
    const source = flow.source && fs.existsSync(at('flowise/nodes', flow.source))
    if (!exported && !source) fail(`modules.json ${name}: flow ${flow.name} has neither an export nor a source`)
  }
  for (const panel of m.panels || []) {
    for (const file of panel.files || []) {
      if (!fs.existsSync(at('admin-src', file))) fail(`modules.json ${name}: panel file admin-src/${file} is missing`)
    }
  }
  for (const file of m.sharedUi || []) {
    if (!fs.existsSync(at('admin/src', file))) fail(`modules.json ${name}: shared file admin/src/${file} is missing`)
  }
  for (const pack of m.packs || []) {
    const info = assets.packs[pack]
    if (!info) fail(`modules.json ${name}: node pack ${pack} has no source in assets.json`)
    else if (info.local) {
      if (!fs.existsSync(at(info.local))) fail(`assets.json pack ${pack}: ${info.local} is not in the repository`)
    } else if (info.manual) warn.push(`assets.json pack ${pack}: no public source - fetch-assets cannot install it`)
    else if (!info.ref && !info.version) warn.push(`assets.json pack ${pack}: not pinned (no ref or version)`)
  }
  for (const file of m.modelFiles || []) {
    const info = assets.models[file] || assets.models[file.split('/').pop()]
    if (!info) fail(`modules.json ${name}: model ${file} is not in assets.json`)
  }
}
// Dependency cycles would send install-module.ps1 round in circles.
function visit(name, trail) {
  if (trail.includes(name)) return fail(`modules.json: dependency cycle ${[...trail, name].join(' -> ')}`)
  for (const dep of (modules[name] && modules[name].needs) || []) visit(dep, [...trail, name])
}
names.forEach((n) => visit(n, []))

// ---------------------------------------------------------------- tabs
for (const tab of readJson('install/tabs.json')) {
  if (!tab.from) continue
  const base = at('admin-src', tab.from.replace(/^\.\//, ''))
  if (!['.tsx', '.ts', '/index.tsx', '/index.ts'].some((ext) => fs.existsSync(base + ext))) {
    fail(`tabs.json ${tab.id}: its panel ${tab.from} is not in admin-src`)
  }
}

// ---------------------------------------------------------------- edge functions
for (const fn of readJson('install/functions/functions.json')) {
  if (!fs.existsSync(at('install/functions', fn.file))) fail(`functions.json ${fn.slug}: ${fn.file} is missing`)
  if (!modules[fn.module]) fail(`functions.json ${fn.slug}: module '${fn.module}' does not exist`)
}

// ---------------------------------------------------------------- report
for (const w of warn) console.warn('warning: ' + w)
for (const p of problems) console.error('problem: ' + p)
console.log(`${parsed} flow sources parse; ${names.length} modules checked; ${problems.length} problem(s), ${warn.length} warning(s)`)
process.exit(problems.length ? 1 : 0)
