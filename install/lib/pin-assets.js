#!/usr/bin/env node
/**
 * Pin every node pack and model in install/assets.json to an exact version.
 *
 * Unpinned, fetch-assets.ps1 installed whatever each pack's newest commit was on
 * the day, and one upstream release (PanoramaStickers 1.5) broke the panorama
 * graph without a line of this repository changing. Pinned, an install gets
 * what was pinned; moving to a newer version is a deliberate re-run of this.
 *
 *   node install/lib/pin-assets.js [--installed survey.json] [--only-missing] [--models]
 *
 * --installed  what a working ComfyUI machine has, as a JSON array of
 *              { name, sha, url, version } per custom_nodes folder. A pack found
 *              there is pinned to that commit or version and marked tested,
 *              because the flows are known to run against it. Anything else is
 *              pinned to its upstream head today and marked untested.
 * --only-missing  leave existing pins alone.
 * --models     also pin Hugging Face models: the repository revision, and each
 *              file's sha256 and size, which fetch-model.py then checks.
 *
 * Needs git and network. Rewrites assets.json in place.
 */
'use strict'

const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')

const FILE = path.join(__dirname, '..', 'assets.json')
const arg = (n) => {
  const i = process.argv.indexOf('--' + n)
  return i > 0 ? process.argv[i + 1] : null
}
const flag = (n) => process.argv.includes('--' + n)
const today = new Date().toISOString().slice(0, 10)

const assets = JSON.parse(fs.readFileSync(FILE, 'utf8'))
const installed = arg('installed') ? JSON.parse(fs.readFileSync(arg('installed'), 'utf8')) : []
const onMachine = new Map(installed.map((p) => [String(p.name).toLowerCase(), p]))
const onlyMissing = flag('only-missing')

function upstreamHead(url) {
  const out = execFileSync('git', ['ls-remote', url, 'HEAD'], { encoding: 'utf8', timeout: 30000 })
  const sha = out.split(/\s/)[0]
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error('no HEAD')
  return sha
}

async function registryLatest(id) {
  const res = await fetch('https://api.comfy.org/nodes/' + encodeURIComponent(id))
  if (!res.ok) throw new Error('registry ' + res.status)
  const body = await res.json()
  const v = body.latest_version && body.latest_version.version
  if (!v) throw new Error('registry lists no version')
  return v
}

async function pinPacks() {
  for (const [name, info] of Object.entries(assets.packs)) {
    if (info.manual || info.local) continue
    if (onlyMissing && (info.ref || info.version)) continue
    const have = onMachine.get(name.toLowerCase())
    try {
      if (have && have.sha && info.git) {
        info.ref = have.sha
        delete info.version
        info.pinned = { on: today, from: 'installed', tested: true }
      } else if (have && have.version && info.registry && !info.git) {
        info.version = have.version
        info.pinned = { on: today, from: 'installed', tested: true }
      } else if (info.git) {
        info.ref = upstreamHead(info.git)
        info.pinned = { on: today, from: 'upstream', tested: false }
      } else if (info.registry) {
        info.version = await registryLatest(info.registry)
        info.pinned = { on: today, from: 'upstream', tested: false }
      }
      console.log(`pack  ${name.padEnd(36)} ${(info.ref || info.version || '').slice(0, 12).padEnd(13)} ${info.pinned.from}`)
    } catch (e) {
      console.warn(`pack  ${name}: not pinned - ${e.message}`)
    }
  }
}

async function hf(route, init) {
  const headers = {}
  if (process.env.HF_TOKEN) headers.Authorization = 'Bearer ' + process.env.HF_TOKEN
  const res = await fetch('https://huggingface.co/api/' + route, { ...init, headers: { ...headers, ...(init && init.headers) } })
  if (!res.ok) throw new Error(`${res.status} ${route.split('/').slice(0, 3).join('/')}`)
  return res.json()
}

async function pinModels() {
  const revisions = new Map()
  for (const [file, info] of Object.entries(assets.models)) {
    const src = info.source || {}
    if (src.type !== 'huggingface') continue
    if (onlyMissing && src.revision && src.sha256) continue
    try {
      if (!revisions.has(src.repo)) revisions.set(src.repo, (await hf(`models/${src.repo}/revision/main`)).sha)
      const revision = revisions.get(src.repo)
      let filePath = src.path
      if (!filePath) {
        const tree = await hf(`models/${src.repo}/tree/${revision}?recursive=true`)
        const hit = tree.find((t) => t.type === 'file' && t.path.split('/').pop() === file.split('/').pop())
        if (!hit) throw new Error('not in the repository')
        filePath = hit.path
      }
      const [meta] = await hf(`models/${src.repo}/paths-info/${revision}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ paths: [filePath] })
      })
      if (!meta || !meta.lfs) throw new Error('no checksum published for it')
      src.path = filePath
      src.revision = revision
      src.sha256 = meta.lfs.oid
      src.bytes = meta.lfs.size
      console.log(`model ${file.padEnd(60)} ${revision.slice(0, 10)} ${meta.lfs.oid.slice(0, 10)}`)
    } catch (e) {
      console.warn(`model ${file}: not pinned - ${e.message}`)
    }
  }
}

;(async () => {
  await pinPacks()
  if (flag('models')) await pinModels()
  fs.writeFileSync(FILE, JSON.stringify(assets, null, 2) + '\n')
})().catch((e) => {
  console.error(e.message)
  process.exit(1)
})
