import { useCallback, useEffect, useRef, useState } from 'react'

// What ComfyUI is actually doing, and a way to stop it.
//
// Until now the only way to see or cancel a render was ComfyUI's own web UI.
// Worth knowing about the two different kinds of stop, because they are not
// interchangeable: a PENDING job can be deleted from the queue outright, but a
// job that has already started can only be INTERRUPTED - deleting it does
// nothing, which is a trap that has cost real GPU time here before.

// Verified against ComfyUI's own server.py: items are queued as
// (number, prompt_id, prompt, extra_data, outputs_to_execute, sensitive) and the
// API strips the last field. extra_data.create_time is a real ms timestamp, so
// elapsed time is accurate even for a job that started before this page loaded.
type QueueEntry = [number, string, Record<string, ComfyNode>, { create_time?: number }, unknown]
type ComfyNode = { class_type: string; inputs: Record<string, unknown> }

type Job = {
  promptId: string
  number: number
  createdAt: number | null
  what: string
  detail: string
}

const COMFY = import.meta.env.VITE_COMFY_URL

// Pull something human out of the graph: where it saves, and how big.
function describe(prompt: Record<string, ComfyNode>): { what: string; detail: string } {
  const nodes = Object.values(prompt ?? {})
  let what = ''
  let detail = ''
  for (const n of nodes) {
    if (!n || typeof n !== 'object') continue
    const prefix = n.inputs?.filename_prefix
    if (typeof prefix === 'string' && !what) what = prefix
    if (/MiniMaxH3(ImageToVideo|ReferenceToVideo)/.test(n.class_type)) {
      const { width, height, length } = n.inputs as { width?: number; height?: number; length?: number }
      if (width && height) {
        const secs = length ? ` · ${(length / 24).toFixed(1)}s (${length}f)` : ''
        detail = `${width}x${height}${secs}`
      }
    }
  }
  if (!what) {
    const kinds = nodes.map((n) => n?.class_type).filter(Boolean)
    what = kinds.length ? `${kinds.length} nodes` : 'job'
  }
  return { what, detail }
}

export function ComfyJobsPanel() {
  const [running, setRunning] = useState<Job[]>([])
  const [pending, setPending] = useState<Job[]>([])
  const [reachable, setReachable] = useState(true)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState('')
  const [open, setOpen] = useState(false)
  const startedAt = useRef<Record<string, number>>({})
  const rootRef = useRef<HTMLDivElement | null>(null)
  const [, forceTick] = useState(0)

  const toJobs = (entries: QueueEntry[]): Job[] =>
    (entries ?? []).map((e) => ({
      promptId: e[1],
      number: e[0],
      createdAt: typeof e[3]?.create_time === 'number' ? e[3].create_time : null,
      ...describe(e[2])
    }))

  const refresh = useCallback(async () => {
    try {
      const res = await fetch(`${COMFY}/queue`)
      if (!res.ok) throw new Error(String(res.status))
      const data = await res.json()
      const run = toJobs(data.queue_running)
      setRunning(run)
      setPending(toJobs(data.queue_pending))
      setReachable(true)
      // Fall back to first-seen only if ComfyUI did not report a create_time.
      const now = Date.now()
      for (const j of run) if (!j.createdAt && !startedAt.current[j.promptId]) startedAt.current[j.promptId] = now
      for (const id of Object.keys(startedAt.current)) {
        if (!run.some((j) => j.promptId === id)) delete startedAt.current[id]
      }
    } catch {
      setReachable(false)
      setRunning([])
      setPending([])
    }
  }, [])

  // Poll faster while the menu is open; slowly when it is just a status light.
  useEffect(() => {
    refresh()
    const poll = setInterval(refresh, open ? 2500 : 8000)
    // Separate, faster tick purely so the elapsed clock advances.
    const clock = setInterval(() => forceTick((n) => n + 1), 1000)
    return () => {
      clearInterval(poll)
      clearInterval(clock)
    }
  }, [refresh, open])

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  async function cancelPending(promptId: string) {
    setBusy(true)
    setNote('')
    try {
      await fetch(`${COMFY}/queue`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ delete: [promptId] })
      })
      setNote(`Removed ${promptId.slice(0, 8)} from the queue.`)
    } catch {
      setNote('Could not reach ComfyUI to cancel that job.')
    }
    setBusy(false)
    refresh()
  }

  // ComfyUI's /interrupt takes an optional prompt_id, so this stops exactly the
  // job you clicked rather than whatever happens to be running by the time the
  // request lands - which matters when a queue is moving.
  async function interruptRunning(promptId: string) {
    setBusy(true)
    setNote('')
    try {
      await fetch(`${COMFY}/interrupt`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt_id: promptId })
      })
      setNote(`Interrupted ${promptId.slice(0, 8)}. Its row will report a failure.`)
    } catch {
      setNote('Could not reach ComfyUI to interrupt.')
    }
    setBusy(false)
    setTimeout(refresh, 600)
  }

  async function clearPending() {
    setBusy(true)
    setNote('')
    try {
      await fetch(`${COMFY}/queue`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clear: true })
      })
      setNote('Cleared everything waiting. The running job was not affected.')
    } catch {
      setNote('Could not reach ComfyUI to clear the queue.')
    }
    setBusy(false)
    refresh()
  }

  /**
   * The kill switch. One press, from any tab, whatever is running.
   *
   * Everything else here is per job: find the row, press its stop. That is the
   * wrong shape when a stage is grinding through forty shots and you want it to
   * stop NOW - the queue goes first so interrupting does not simply start the
   * next one, then every running job is interrupted by id.
   */
  async function killAll() {
    setBusy(true)
    setNote('')
    try {
      await fetch(`${COMFY}/queue`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clear: true })
      })
      // By id rather than a bare interrupt: a bare one stops whatever happens to
      // be running at that instant, which may already be the next job.
      for (const j of running) {
        await fetch(`${COMFY}/interrupt`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ prompt_id: j.promptId })
        })
      }
      // And once more unqualified, for anything that started in between.
      await fetch(`${COMFY}/interrupt`, { method: 'POST' })
      setNote('Stopped everything. A stage that was mid-run will stop at its next shot.')
    } catch {
      setNote('Could not reach ComfyUI to stop it.')
    }
    setBusy(false)
    setTimeout(refresh, 600)
  }

  const elapsed = (j: Job) => {
    const t = j.createdAt ?? startedAt.current[j.promptId]
    if (!t) return ''
    const s = Math.floor((Date.now() - t) / 1000)
    return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`
  }

  const total = running.length + pending.length

  return (
    <div className="jobs" ref={rootRef}>
      <button
        type="button"
        className="jobs-trigger"
        onClick={() => setOpen((o) => !o)}
        title="ComfyUI running jobs"
      >
        <span className={reachable ? (running.length ? 'jobs-dot busy' : 'jobs-dot idle') : 'jobs-dot down'} />
        <span>
          {!reachable ? 'ComfyUI offline' : total === 0 ? 'Idle' : `${running.length} running`}
          {reachable && pending.length > 0 ? ` · ${pending.length} queued` : ''}
        </span>
        <span className="jobs-caret">▾</span>
      </button>
      {/* Beside the indicator, not inside the panel: when you want it, you want
          it without opening a menu and finding a row. Only shown when there is
          something to stop. */}
      {reachable && total > 0 && (
        <button
          type="button"
          className="danger jobs-kill"
          disabled={busy}
          title="Stop everything ComfyUI is doing, now"
          onClick={killAll}
        >
          Stop all
        </button>
      )}

      {open && (
        <div className="jobs-menu">
          <div className="jobs-menu-title">ComfyUI Running Jobs</div>
          {!reachable && (
            <p className="empty">
              ComfyUI is not answering on {COMFY}. Start it with <code>python main.py --enable-cors-header</code>.
            </p>
          )}

          {reachable && total === 0 && <p className="empty">Nothing queued or rendering.</p>}

          {running.map((j) => (
            <div className="job job-running" key={j.promptId}>
              <span className="badge">running</span>
              <span className="job-what">{j.what}</span>
              {j.detail && <span className="empty">{j.detail}</span>}
              <span className="empty">{elapsed(j)}</span>
              <span className="empty">{j.promptId.slice(0, 8)}</span>
              <button type="button" className="danger" disabled={busy} onClick={() => interruptRunning(j.promptId)}>
                Stop
              </button>
            </div>
          ))}

          {pending.map((j) => (
            <div className="job" key={j.promptId}>
              <span className="badge">waiting</span>
              <span className="job-what">{j.what}</span>
              {j.detail && <span className="empty">{j.detail}</span>}
              <span className="empty">{j.promptId.slice(0, 8)}</span>
              <button type="button" disabled={busy} onClick={() => cancelPending(j.promptId)}>
                Cancel
              </button>
            </div>
          ))}

          <div className="upload-form">
            <button type="button" onClick={refresh}>
              Refresh
            </button>
            {pending.length > 1 && (
              <button type="button" disabled={busy} onClick={clearPending}>
                Cancel all waiting ({pending.length})
              </button>
            )}
          </div>
          {note && <p className="run-status-ok">{note}</p>}
          {running.length > 0 && (
            <p className="empty">
              Stopping a job that has already started interrupts it — the clip's row will be marked failed, and any GPU
              time already spent on it is lost. Jobs still waiting can be cancelled cleanly.
            </p>
          )}
        </div>
      )}
    </div>
  )
}
