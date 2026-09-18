/**
 * Generate install/REQUIREMENTS-BY-MODULE.md from the module map.
 *
 * Written rather than hand-maintained so it cannot drift from modules.json,
 * which is the thing the installers actually read. Re-run after editing the map:
 *
 *   node install/lib/write-requirements.js
 */
const fs = require('fs')
const path = require('path')

const INSTALL = path.resolve(__dirname, '..')
const map = JSON.parse(fs.readFileSync(path.join(INSTALL, 'modules.json'), 'utf8'))
const tabs = JSON.parse(fs.readFileSync(path.join(INSTALL, 'tabs.json'), 'utf8'))
const names = Object.keys(map).filter((k) => !k.startsWith('$'))

const tabLabel = new Map(tabs.map((t) => [t.id, t.label]))
const out = []

out.push('# Requirements, module by module')
out.push('')
out.push('GENERATED from `modules.json` by `lib/write-requirements.js` - do not edit by hand.')
out.push('')
out.push('What each module needs before it will work, and what it adds. The global requirements -')
out.push('hardware, runtimes, service versions - are in [../requirements.md](../requirements.md);')
out.push('this is only what varies per module.')
out.push('')
out.push('## At a glance')
out.push('')
out.push('| Module | Needs | Tabs | Tables | Flows | Node packs |')
out.push('|---|---|---|---|---|---|')
for (const name of names) {
  const m = map[name]
  const needs = (m.needs || []).join(', ') || '-'
  const tabIds = (m.panels || []).map((p) => p.tab).filter(Boolean)
  const tabNames = tabIds.map((id) => tabLabel.get(id) || id).join(', ') || '-'
  out.push(`| \`${name}\` | ${needs} | ${tabNames} | ${(m.tables || []).length} | ${(m.flows || []).length} | ${(m.packs || []).length} |`)
}
out.push('')

out.push('## What each one needs in place')
out.push('')
for (const name of names) {
  const m = map[name]
  out.push(`### \`${name}\` — ${m.title}`)
  out.push('')
  out.push(m.summary)
  out.push('')
  const deps = (m.needs || []).filter(Boolean)
  out.push(`- **Modules first:** ${deps.length ? deps.map((d) => `\`${d}\``).join(', ') : 'none'}`)
  if ((m.optional || []).length) {
    out.push(`- **Optional:** ${m.optional.map((d) => `\`${d}\``).join(', ')} — used if present, skipped if not`)
  }
  out.push(`- **ComfyUI node packs:** ${(m.packs || []).length ? m.packs.map((p) => `\`${p}\``).join(', ') : 'none'}`)
  if ((m.models || []).length) {
    out.push('- **Models:**')
    for (const model of m.models) out.push(`  - ${model}`)
  } else {
    out.push('- **Models:** none')
  }
  if ((m.postgresExtensions || []).length) {
    out.push(`- **Postgres extensions:** ${m.postgresExtensions.map((e) => `\`${e}\``).join(', ')}`)
  }
  const tabIds = (m.panels || []).map((p) => p.tab).filter(Boolean)
  if (tabIds.length) {
    out.push(`- **Adds tabs:** ${tabIds.map((id) => tabLabel.get(id) || id).join(', ')}`)
  }
  if ((m.tables || []).length) {
    out.push(`- **Creates tables:** ${m.tables.map((t) => `\`${t}\``).join(', ')}`)
  }
  const doc = path.join(INSTALL, 'modules', name, 'README.md')
  if (fs.existsSync(doc)) out.push(`- **Full page:** [modules/${name}/README.md](modules/${name}/README.md)`)
  out.push('')
}

out.push('## Install order')
out.push('')
out.push('Dependencies first. One order that satisfies every module:')
out.push('')
const done = new Set()
const order = []
let guard = 0
while (order.length < names.length && guard++ < 100) {
  for (const name of names) {
    if (done.has(name)) continue
    if ((map[name].needs || []).every((d) => done.has(d) || !names.includes(d))) {
      done.add(name)
      order.push(name)
    }
  }
}
out.push('```powershell')
for (const name of order) {
  out.push(name === 'core' ? '.\\core\\03-core.ps1' : `.\\install-module.ps1 -Module ${name}`)
}
out.push('```')
out.push('')
out.push('You do not need all of them. Install the modules whose features you want; the installer')
out.push('refuses anything whose dependencies are missing and tells you what to install first.')
out.push('')

const dest = path.join(INSTALL, 'REQUIREMENTS-BY-MODULE.md')
fs.writeFileSync(dest, out.join('\n'), 'utf8')
console.log(`wrote ${path.relative(process.cwd(), dest)} (${names.length} modules)`)
