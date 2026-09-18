import { useEffect, useState } from 'react'
import { insforge, type Movie, type Beat } from './insforge'
import { triggerOrchestrator, type RunStatus } from './flowise'



export function BeatsPanel({ movie }: { movie: Movie }) {
  const [beats, setBeats] = useState<Beat[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<string | null>(null)
  const [runStatus, setRunStatus] = useState<Record<string, RunStatus>>({})

  useEffect(() => {
    async function load() {
      setLoading(true)
      const { data, error } = await insforge.database
        .from('beats')
        .select('*')
        .eq('movie_id', movie.id)
        .order('sequence_index', { ascending: true })
      if (error) setError(error.message)
      else setBeats((data ?? []) as Beat[])
      setLoading(false)
    }
    load()
  }, [movie.id])

  async function handleRun(beat: Beat, e: React.MouseEvent) {
    e.stopPropagation()
    if (!beat.beat_code) return
    setRunStatus((prev) => ({ ...prev, [beat.id]: { state: 'running', message: '' } }))
    const result = await triggerOrchestrator(beat.beat_code)
    setRunStatus((prev) => ({ ...prev, [beat.id]: result }))
  }

  if (loading) return <p>Loading beats…</p>
  if (error) return <p className="error">{error}</p>
  if (beats.length === 0) return <p className="empty">No beats generated for {movie.title} yet.</p>

  return (
    <div className="beats-list">
      {beats.map((beat) => {
        const status = runStatus[beat.id]
        return (
        <div className="beat-card" key={beat.id}>
          <div className="beat-card-header" onClick={() => setExpanded(expanded === beat.id ? null : beat.id)}>
            <span className="beat-code">{beat.beat_code ?? `seq ${beat.sequence_index}`}</span>
            <span className="beat-location">
              {beat.int_ext ? `${beat.int_ext}. ` : ''}
              {beat.location ?? '(no location)'}
              {beat.time_of_day ? ` — ${beat.time_of_day}` : ''}
            </span>
            <span className="beat-lines">
              lines {beat.line_start}–{beat.line_end}
            </span>
            {beat.beat_code && (
              <button
                type="button"
                className="run-beat-btn"
                disabled={status?.state === 'running'}
                onClick={(e) => handleRun(beat, e)}
              >
                {status?.state === 'running' ? 'Running…' : 'Run'}
              </button>
            )}
          </div>
          {status && status.state !== 'running' && (
            <p className={status.state === 'error' ? 'error' : 'run-status-ok'}>{status.message}</p>
          )}
          <p className="beat-summary">{beat.summary}</p>
          <div className="beat-tags">
            {beat.characters.map((c) => (
              <span className="badge" key={c.name} title={c.blocking}>
                {c.name}
              </span>
            ))}
          </div>

          {expanded === beat.id && (
            <div className="beat-detail">
              {beat.objects.length > 0 && (
                <>
                  <h4>Objects</h4>
                  <ul>
                    {beat.objects.map((o) => (
                      <li key={o.name}>
                        <strong>{o.name}</strong>
                        {o.notes ? ` — ${o.notes}` : ''}
                      </li>
                    ))}
                  </ul>
                </>
              )}
              {beat.characters.length > 0 && (
                <>
                  <h4>Characters &amp; Blocking</h4>
                  <ul>
                    {beat.characters.map((c) => (
                      <li key={c.name}>
                        <strong>{c.name}</strong>
                        {c.blocking ? <em> ({c.blocking})</em> : null}
                      </li>
                    ))}
                  </ul>
                </>
              )}
              {beat.dialogue.length > 0 && (
                <>
                  <h4>Dialogue</h4>
                  <ul className="dialogue">
                    {beat.dialogue.map((d, i) => (
                      <li key={i}>
                        <strong>{d.character}</strong>
                        {d.parenthetical ? ` (${d.parenthetical})` : ''}: {d.line}
                      </li>
                    ))}
                  </ul>
                </>
              )}
              <h4>Raw Script Excerpt</h4>
              <p className="raw-text">{beat.raw_text}</p>
            </div>
          )}
        </div>
        )
      })}
    </div>
  )
}
