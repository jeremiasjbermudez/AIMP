/**
 * Settings: what is installed, and installing more.
 *
 * Reached from the gear in the header rather than from the tab bar, because it
 * is about the app itself rather than about a project.
 *
 * The installers are PowerShell and a browser cannot run them, so this asks a
 * flow to run them on the machine. That flow only accepts a module NAME, which
 * it checks against the module map before it spawns anything.
 */
import { useEffect, useState } from 'react'
import { triggerFlow, parseFlowJson } from './flowise'

type Module = {
  name: string
  title: string
  summary: string
  installed: boolean
  installedAt: string | null
  needs: string[]
  tabs: string[]
  tables: number
  flows: number
  packs: string[]
  models: string[]
}

type Reply = { modules?: Module[]; log?: string; note?: string; reason?: string; error?: string }

export function SettingsPanel({ onClose }: { onClose: () => void }) {
  const [modules, setModules] = useState<Module[]>([])
  const [busy, setBusy] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [log, setLog] = useState<string | null>(null)
  const [open, setOpen] = useState<string | null>(null)

  const flowId = import.meta.env.VITE_INSTALL_MODULE_ID

  async function call(body: Record<string, unknown>) {
    const res = parseFlowJson<Reply>(await triggerFlow(flowId, body))
    if (!res.ok) return { error: res.message }
    if (res.data.error || res.data.reason) return { error: res.data.error ?? res.data.reason, log: res.data.log }
    return res.data
  }

  async function load() {
    if (!flowId) {
      setNote('VITE_INSTALL_MODULE_ID is not set. Re-install the core module, then restart the dev server.')
      return
    }
    setBusy('list')
    const out = await call({ action: 'list' })
    setBusy(null)
    if ('error' in out && out.error) {
      setNote(out.error)
      return
    }
    setModules(out.modules ?? [])
  }

  useEffect(() => {
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function run(action: 'install' | 'uninstall', name: string) {
    setBusy(name)
    setNote(null)
    setLog(null)
    const out = await call({ action, module: name })
    setBusy(null)
    if ('error' in out && out.error) {
      setNote(out.error)
      setLog(out.log ?? null)
      return
    }
    setModules(out.modules ?? modules)
    setNote(out.note ?? `${action === 'install' ? 'Installed' : 'Removed'} ${name}.`)
    setLog(out.log ?? null)
  }

  /**
   * Every available module, one request at a time, in the module map's order.
   * Strictly sequential: two installers at once would both rewrite admin/.env
   * and the tab registry. Installing one module can bring in others it needs,
   * so the list is re-read after each and anything already there is skipped.
   * Stops at the first failure and leaves the rest for another try.
   */
  async function installAll() {
    const queue = modules.filter((m) => !m.installed)
    if (!queue.length) return
    const ok = window.confirm(
      `Install all ${queue.length} available modules, one after another?\n\n` +
        'Each one opens its own window to download its ComfyUI models and node packs. ' +
        'Together they run to hundreds of gigabytes.'
    )
    if (!ok) return
    setNote(null)
    setLog(null)
    let current = modules
    const done: string[] = []
    for (const [i, m] of queue.entries()) {
      if (current.find((c) => c.name === m.name)?.installed) continue
      setBusy(m.name)
      setNote(`Installing ${i + 1} of ${queue.length}: ${m.title}…`)
      const out = await call({ action: 'install', module: m.name })
      if ('error' in out && out.error) {
        setBusy(null)
        setNote(
          `${m.title} failed, so the install stopped there. ` +
            (done.length ? `Installed before it: ${done.join(', ')}. ` : '') +
            out.error
        )
        setLog(out.log ?? null)
        if ('modules' in out && out.modules) setModules(out.modules)
        return
      }
      current = out.modules ?? current
      setModules(current)
      setLog(out.log ?? null)
      done.push(m.title)
    }
    setBusy(null)
    setNote(`Installed ${done.length} module${done.length === 1 ? '' : 's'}. Restart the admin dev server to see the new tabs.`)
  }

  const installed = modules.filter((m) => m.installed)
  const available = modules.filter((m) => !m.installed)

  return (
    <div className="settings-page">
      <header className="settings-head">
        <div>
          <h2>Settings</h2>
          <p className="empty">
            What this install has, and what else it can have. Each feature is a module: its tables,
            its flows and its tabs arrive together.
          </p>
        </div>
        <button type="button" onClick={onClose}>
          Close
        </button>
      </header>

      {note && <p className={/not set|failed/.test(note) ? 'error' : 'empty'}>{note}</p>}
      {log && (
        <details className="settings-log">
          <summary className="empty">What the installer said</summary>
          <pre>{log}</pre>
        </details>
      )}

      {busy === 'list' && <p className="empty">Reading what is installed…</p>}

      <h3>Installed ({installed.length})</h3>
      <div className="settings-modules">
        {installed.map((m) => (
          <ModuleCard
            key={m.name}
            module={m}
            busy={busy === m.name}
            open={open === m.name}
            onToggle={() => setOpen(open === m.name ? null : m.name)}
            action={
              m.name === 'core' ? null : (
                <button type="button" disabled={!!busy} onClick={() => run('uninstall', m.name)}>
                  {busy === m.name ? 'Removing…' : 'Remove'}
                </button>
              )
            }
          />
        ))}
      </div>

      <h3>Available ({available.length})</h3>
      <div className="settings-modules">
        {available.map((m) => (
          <ModuleCard
            key={m.name}
            module={m}
            busy={busy === m.name}
            open={open === m.name}
            onToggle={() => setOpen(open === m.name ? null : m.name)}
            action={
              <button type="button" className="primary" disabled={!!busy} onClick={() => run('install', m.name)}>
                {busy === m.name ? 'Installing…' : 'Install'}
              </button>
            }
          />
        ))}
      </div>

      {available.length > 1 && (
        <div className="settings-install-all">
          <button type="button" className="primary" disabled={!!busy} onClick={installAll}>
            {busy && busy !== 'list' ? 'Installing…' : `Install all (${available.length})`}
          </button>
        </div>
      )}

      <p className="empty">
        Removing a module takes away its tabs and keeps its data. Dropping the tables is deliberate
        work, done from the command line, so a click cannot destroy a project.
      </p>
    </div>
  )
}

function ModuleCard({
  module: m,
  busy,
  open,
  onToggle,
  action
}: {
  module: Module
  busy: boolean
  open: boolean
  onToggle: () => void
  action: React.ReactNode
}) {
  return (
    <div className={'settings-module' + (busy ? ' is-busy' : '')}>
      <div className="settings-module-head">
        <div>
          <strong>{m.title}</strong>
          <p className="empty">{m.summary}</p>
        </div>
        {action}
      </div>
      <button type="button" className="settings-more" onClick={onToggle}>
        {open ? 'Less' : 'What it brings'}
      </button>
      {open && (
        <dl className="settings-detail">
          {m.tabs.length > 0 && (
            <>
              <dt>Tabs</dt>
              <dd>{m.tabs.join(', ')}</dd>
            </>
          )}
          <dt>Creates</dt>
          <dd>
            {m.tables} table{m.tables === 1 ? '' : 's'}, {m.flows} flow{m.flows === 1 ? '' : 's'}
          </dd>
          {m.needs.length > 0 && (
            <>
              <dt>Needs</dt>
              <dd>{m.needs.join(', ')} — installed first if missing</dd>
            </>
          )}
          {m.packs.length > 0 && (
            <>
              <dt>ComfyUI packs</dt>
              <dd>{m.packs.join(', ')}</dd>
            </>
          )}
          {m.models.length > 0 && (
            <>
              <dt>Models</dt>
              <dd>{m.models.join('; ')}</dd>
            </>
          )}
        </dl>
      )}
    </div>
  )
}
