import { useEffect, useRef, useState } from 'react'
import { insforge, type Movie, type MinimaxClip } from './insforge'
import { triggerFlow, type RunStatus } from './flowise'

// Sends this movie's finished clips to DaVinci Resolve as a new project.
//
// Nothing here is AI-driven: the pipeline already knows which beat each clip
// belongs to, so the timeline can arrive in screenplay order. That ordering is
// the one thing an editor cannot work out for itself, and it is the reason this
// is worth doing from here rather than importing by hand.
type ResolveStatus = {
  ok?: boolean
  product?: string
  currentProject?: string | null
  timelines?: number
  error?: string
}

type ToolCall = { tool: string; ok: boolean; args?: Record<string, unknown> }
type ApiMethod = { object: string; signature: string; description: string }
type Capabilities = { methodCount: number; methods: ApiMethod[]; settingCount: number; settings: Record<string, unknown> }
type ChatTurn = { role: 'user' | 'assistant'; content: string; trace?: ToolCall[] }

export function ResolvePanel({ movie }: { movie: Movie }) {
  const [clips, setClips] = useState<MinimaxClip[]>([])
  const [revoicedCount, setRevoicedCount] = useState(0)
  const [projectName, setProjectName] = useState('')
  const [makeTimeline, setMakeTimeline] = useState(true)
  const [resolveInfo, setResolveInfo] = useState<ResolveStatus | null>(null)
  const [checking, setChecking] = useState(false)
  const [status, setStatus] = useState<RunStatus | null>(null)
  const [result, setResult] = useState<Record<string, unknown> | null>(null)
  const [error, setError] = useState<string | null>(null)
  // The chat is deliberately scoped to Resolve only - it has a fixed set of
  // verbs and cannot reach anything else in the pipeline.
  const [chat, setChat] = useState<ChatTurn[]>([])
  const [ask, setAsk] = useState('')
  const [thinking, setThinking] = useState(false)
  // A searchable index of what Resolve can actually be asked to do, so its
  // abilities are browsable rather than something you have to guess at.
  const [capQuery, setCapQuery] = useState('')
  const [caps, setCaps] = useState<Capabilities | null>(null)
  const [capBusy, setCapBusy] = useState(false)
  const [capOpen, setCapOpen] = useState(false)
  const chatEndRef = useRef<HTMLDivElement | null>(null)

  const flowId = import.meta.env.VITE_RESOLVE_ID
  const chatFlowId = import.meta.env.VITE_RESOLVE_CHAT_ID

  async function loadClips() {
    const { data, error: e } = await insforge.database
      .from('minimax_clips')
      .select('*')
      .eq('movie_id', movie.id)
      .eq('status', 'complete')
    if (e) setError(e.message)
    else setClips(((data ?? []) as MinimaxClip[]).filter((c) => c.video_path))

    const { data: vr } = await insforge.database
      .from('voice_replacements')
      .select('clip_id,output_path')
      .eq('movie_id', movie.id)
      .eq('status', 'complete')
    const ids = new Set((vr ?? []).map((v: { clip_id: string | null }) => v.clip_id).filter(Boolean))
    setRevoicedCount(ids.size)
  }

  async function checkResolve() {
    setChecking(true)
    setError(null)
    const r = await triggerFlow(flowId, { action: 'status' })
    setChecking(false)
    if (r.state === 'error') {
      setResolveInfo({ error: r.message })
      return
    }
    try {
      setResolveInfo(JSON.parse(r.message) as ResolveStatus)
    } catch {
      setResolveInfo({ error: 'Could not read the response from Resolve.' })
    }
  }

  useEffect(() => {
    loadClips()
    setProjectName(movie.title)
    setResult(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [movie.id])

  useEffect(() => {
    checkResolve()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function handleDeliver() {
    setError(null)
    setResult(null)
    setStatus({ state: 'running', message: '' })
    const r = await triggerFlow(flowId, {
      action: 'deliver',
      movieId: movie.id,
      projectName: projectName.trim() || movie.title,
      timeline: makeTimeline
    })
    setStatus(r)
    if (r.state !== 'error') {
      try {
        setResult(JSON.parse(r.message) as Record<string, unknown>)
      } catch {
        /* the status line already carries the message */
      }
    }
  }

  async function handleAsk() {
    const text = ask.trim()
    if (!text || thinking) return
    setAsk('')
    setThinking(true)
    const nextTurns: ChatTurn[] = [...chat, { role: 'user', content: text }]
    setChat(nextTurns)
    const r = await triggerFlow(chatFlowId, {
      action: 'chat',
      movieId: movie.id,
      // Only the conversation goes back, not the tool traces - the model gets
      // tool results inside its own loop and does not need them replayed.
      messages: nextTurns.map((t) => ({ role: t.role, content: t.content }))
    })
    setThinking(false)
    if (r.state === 'error') {
      setChat([...nextTurns, { role: 'assistant', content: r.message }])
      return
    }
    try {
      const payload = JSON.parse(r.message)
      setChat([
        ...nextTurns,
        { role: 'assistant', content: payload.error ?? payload.reply ?? '(no reply)', trace: payload.trace ?? [] }
      ])
    } catch {
      setChat([...nextTurns, { role: 'assistant', content: r.message }])
    }
    loadClips()
    checkResolve()
  }

  async function searchCaps(q: string) {
    setCapBusy(true)
    const r = await triggerFlow(flowId, { action: 'capabilities', query: q })
    setCapBusy(false)
    if (r.state === 'error') {
      setError(r.message)
      return
    }
    try {
      setCaps(JSON.parse(r.message) as Capabilities)
    } catch {
      setError('Could not read the capability list.')
    }
  }

  // Keep the newest turn in view. A reply can be several lines plus its tool
  // badges, so without this the answer lands below the fold every time.
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
  }, [chat, thinking])

  const reachable = resolveInfo?.ok === true

  return (
    <div>
      {error && <p className="error">{error}</p>}
      <h3>DaVinci Resolve</h3>
      <p className="empty">
        Creates a new Resolve project for {movie.title}, imports its finished clips and lays them on a timeline in
        screenplay order — the order the beats run in, not the order they happened to render. Resolve must be open.
      </p>

      <h4>Connection</h4>
      <div className="upload-form">
        <button type="button" onClick={checkResolve} disabled={checking}>
          {checking ? 'Checking…' : 'Check Resolve'}
        </button>
        {resolveInfo && reachable && (
          <span className="run-status-ok">
            {resolveInfo.product} — open project “{resolveInfo.currentProject ?? 'none'}”
          </span>
        )}
        {resolveInfo && !reachable && <span className="error">{resolveInfo.error ?? 'Not reachable'}</span>}
      </div>
      {resolveInfo && !reachable && (
        <p className="empty">
          Resolve has to be running, and Preferences → System → General → “External scripting using” must be set to
          Local rather than None.
        </p>
      )}

      <h4>What will be sent</h4>
      <p className="empty">
        {clips.length} finished clip{clips.length === 1 ? '' : 's'}
        {revoicedCount > 0
          ? `, ${revoicedCount} of which have a post-voice version — the re-voiced file is used instead of the original.`
          : '.'}
      </p>

      <h4>Project</h4>
      <div className="upload-form">
        <input
          type="text"
          value={projectName}
          onChange={(e) => setProjectName(e.target.value)}
          placeholder="Resolve project name"
        />
        <label>
          <input type="checkbox" checked={makeTimeline} onChange={(e) => setMakeTimeline(e.target.checked)} /> Build a
          timeline as well as importing
        </label>
      </div>
      <p className="empty">
        An existing project of the same name is never overwritten — a number is appended instead.
      </p>

      <div className="upload-form">
        <button
          type="button"
          disabled={status?.state === 'running' || clips.length === 0}
          onClick={handleDeliver}
        >
          {status?.state === 'running' ? 'Sending…' : 'Send to Resolve'}
        </button>
      </div>
      {status && status.state !== 'running' && (
        <p className={status.state === 'error' ? 'error' : 'run-status-ok'}>{status.message}</p>
      )}

      <h4>
        <button
          type="button"
          className="caps-toggle"
          onClick={() => {
            const next = !capOpen
            setCapOpen(next)
            if (next && !caps) searchCaps('')
          }}
        >
          {capOpen ? '▾' : '▸'} What can it do?
        </button>
      </h4>
      {capOpen && (
        <>
          <p className="empty">
            Everything below is reachable from the chat — 396 methods across 13 objects from Resolve's own reference,
            plus this project's live settings and their current values. Search it rather than guessing.
          </p>
          <div className="upload-form">
            <input
              type="text"
              className="chat-input"
              value={capQuery}
              placeholder="marker, render, colour, resolution, timeline…"
              onChange={(e) => setCapQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') searchCaps(capQuery)
              }}
            />
            <button type="button" disabled={capBusy} onClick={() => searchCaps(capQuery)}>
              {capBusy ? 'Searching…' : 'Search'}
            </button>
          </div>
          {caps && (
            <div className="caps-results">
              <p className="empty">
                {caps.methodCount} method{caps.methodCount === 1 ? '' : 's'} and {caps.settingCount} setting
                {caps.settingCount === 1 ? '' : 's'} match.
              </p>
              {Object.keys(caps.settings || {}).length > 0 && (
                <div className="caps-block">
                  <div className="chat-role">Settings (current values)</div>
                  {Object.entries(caps.settings).map(([k, v]) => (
                    <div className="caps-row" key={k}>
                      <code>{k}</code>
                      <span className="empty">= {String(v)}</span>
                    </div>
                  ))}
                </div>
              )}
              {caps.methods.length > 0 && (
                <div className="caps-block">
                  <div className="chat-role">Methods</div>
                  {caps.methods.map((m, i) => (
                    <div className="caps-row" key={i}>
                      <span className="badge">{m.object}</span>
                      <code>{m.signature}</code>
                      <span className="empty">{m.description}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </>
      )}

      <h4>Ask Resolve</h4>
      <p className="empty">
        Plain English, for the things a button cannot cover — “import only the crypt beats and build a timeline called
        rough cut”, “set super scale to 4x”, “what frame rate is this project?”. It reaches the whole DaVinci Resolve
        scripting API, so it is not limited to a fixed list of commands. Anything that deletes, closes or overwrites is
        refused until you approve it in words. Each step it takes is listed under its reply, so you can see what it
        really did rather than take its word for it.
      </p>
      <div className="resolve-chat">
        {chat.length === 0 && <p className="empty">Nothing asked yet.</p>}
        {chat.map((t, i) => (
          <div key={i} className={t.role === 'user' ? 'chat-turn chat-user' : 'chat-turn chat-assistant'}>
            <div className="chat-role">{t.role === 'user' ? 'You' : 'Resolve agent'}</div>
            <div className="chat-body">{t.content}</div>
            {t.trace && t.trace.length > 0 && (
              <div className="chat-trace">
                {t.trace.map((c, j) => (
                  <span key={j} className={c.ok ? 'badge' : 'badge chat-failed'}>
                    {c.tool} {c.ok ? '✓' : '✕'}
                  </span>
                ))}
              </div>
            )}
          </div>
        ))}
        {thinking && <p className="empty">Working…</p>}
        <div ref={chatEndRef} />
      </div>
      <div className="upload-form">
        <input
          type="text"
          className="chat-input"
          value={ask}
          placeholder="e.g. build a timeline called rough cut from all the clips"
          onChange={(e) => setAsk(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') handleAsk()
          }}
        />
        <button type="button" disabled={thinking || !ask.trim()} onClick={handleAsk}>
          {thinking ? 'Working…' : 'Send'}
        </button>
        {chat.length > 0 && (
          <button type="button" onClick={() => setChat([])}>
            Clear
          </button>
        )}
      </div>

      {result && (
        <div className="beat-card">
          <div className="take-head">
            <strong>{String(result.project ?? '')}</strong>
            {result.renamed ? <span className="badge">renamed to avoid a clash</span> : null}
            <span className="badge">{String(result.imported ?? 0)} imported</span>
            {result.timeline ? <span className="badge">timeline built</span> : <span className="badge">media only</span>}
            {result.orderedByBeat ? <span className="badge">beat order</span> : <span className="badge">render order</span>}
          </div>
          {Array.isArray(result.missing) && result.missing.length > 0 && (
            <p className="error">
              {result.missing.length} file(s) were missing on disk and were skipped.
            </p>
          )}
          <p className="empty">Switch to Resolve — the project is open there.</p>
        </div>
      )}
    </div>
  )
}
