/**
 * The frames Face QA is complaining about, beside the references it compared
 * them to.
 *
 * A score you cannot inspect is not actionable: "worst 0.42 at 3.2s" asks you
 * to take the recogniser's word for it, and the recogniser is wrong often
 * enough - motion blur, a hand across the jaw, a hard profile - that a number
 * alone is not enough to re-render on.
 *
 * Frames are grabbed by seeking the video and drawing to a canvas, the same way
 * the extend frame picker does. That needs ComfyUI's CORS header, which this
 * pipeline already runs with, and `crossOrigin` set before `src` or the canvas
 * is tainted and `toDataURL` throws.
 */
import { useEffect, useRef, useState } from 'react'
import { comfyViewUrl } from '../insforge'

export type FrameScore = { time: number; frame?: number; similarity: number }

/** Seek one video to a list of times and hand back a still for each. */
async function grabFrames(src: string, times: number[]): Promise<Map<number, string>> {
  const out = new Map<number, string>()
  const v = document.createElement('video')
  v.crossOrigin = 'anonymous'
  v.muted = true
  v.playsInline = true
  v.preload = 'auto'
  v.src = src
  await new Promise<void>((res, rej) => {
    v.onloadeddata = () => res()
    v.onerror = () => rej(new Error('The clip could not be read for frame capture.'))
  })
  const c = document.createElement('canvas')
  c.width = v.videoWidth
  c.height = v.videoHeight
  const ctx = c.getContext('2d')
  if (!ctx) throw new Error('No 2D canvas context.')
  for (const t of times) {
    await new Promise<void>((res) => {
      const done = () => {
        v.removeEventListener('seeked', done)
        res()
      }
      v.addEventListener('seeked', done)
      // Clamp: seeking past the end never fires `seeked` and would hang here.
      v.currentTime = Math.min(Math.max(0, t), Math.max(0, (v.duration || 0) - 0.05))
    })
    ctx.drawImage(v, 0, 0)
    out.set(t, c.toDataURL('image/jpeg', 0.85))
  }
  return out
}

export function WorstFrames({
  videoPath,
  frames,
  good,
  suspect,
  references,
  onFixFrame,
  canFix = true,
  limit = 6
}: {
  videoPath: string
  frames: FrameScore[]
  good: number
  suspect: number
  /** Reference images the score was measured against, as ComfyUI paths. */
  references: { path: string; label: string }[]
  /**
   * Repaint the face on THIS frame and hand back where it landed.
   *
   * The whole action lives on the card. An earlier version only offered to
   * "save" a frame and left you to find the repaint elsewhere, which is not an
   * action - it is a detour.
   */
  onFixFrame?: (frame: number, time: number) => Promise<{ path?: string; error?: string }>
  /** Whether a fix can run at all - false when no character is chosen yet. */
  canFix?: boolean
  limit?: number
}) {
  const [shots, setShots] = useState<Map<number, string>>(new Map())
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  // Per-card state, keyed by frame time: what is running, what came back.
  const [fixing, setFixing] = useState<number | null>(null)
  const [fixed, setFixed] = useState<Map<number, string>>(new Map())
  const [failed, setFailed] = useState<Map<number, string>>(new Map())
  const asked = useRef('')

  // Worst first: the point is to look at the failures, not to scrub the clip.
  const worstFirst = [...frames].sort((a, b) => a.similarity - b.similarity).slice(0, limit)

  useEffect(() => {
    const key = videoPath + worstFirst.map((f) => f.time).join(',')
    if (!videoPath || worstFirst.length === 0 || asked.current === key) return
    asked.current = key
    setBusy(true)
    setError(null)
    grabFrames(comfyViewUrl(videoPath), worstFirst.map((f) => f.time))
      .then(setShots)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(false))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [videoPath, frames])

  const cls = (s: number) => (s >= good ? 'run-status-ok' : s >= suspect ? 'badge' : 'error')

  return (
    <>
      <h4>Worst frames</h4>
      <p className="empty">
        The lowest-scoring frames, worst first, beside the references they were compared with. A low
        score on a hard profile or a motion-blurred frame is usually the recogniser struggling rather
        than the character drifting — which is why this is worth looking at before re-rendering.
      </p>
      {busy && <p className="empty">Grabbing frames…</p>}
      {error && <p className="error">{error}</p>}
      <div className="worst-grid">
        {worstFirst.map((f) => (
          <div className="worst-card" key={f.time}>
            {shots.get(f.time) ? (
              <img className="worst-shot" src={shots.get(f.time)} alt={`frame at ${f.time}s`} />
            ) : (
              <div className="worst-shot worst-shot-blank" />
            )}
            <p>
              <span className={cls(f.similarity)}>{f.similarity.toFixed(3)}</span>{' '}
              <span className="empty">at {f.time}s</span>
              {fixed.has(f.time) && <span className="run-status-ok"> · fixed</span>}
            </p>
            {onFixFrame && (
              <button
                type="button"
                className="grade-toggle"
                disabled={!canFix || fixing !== null}
                title={canFix ? 'Repaint the face on this frame' : 'Pick a character first'}
                onClick={async () => {
                  const frame = f.frame ?? Math.round(f.time * 24)
                  setFixing(f.time)
                  setFailed((m) => {
                    const n = new Map(m)
                    n.delete(f.time)
                    return n
                  })
                  const r = await onFixFrame(frame, f.time)
                  setFixing(null)
                  if (r.path) {
                    // Swap the card to the repaint, so the result is where the
                    // problem was rather than further down the page.
                    setFixed((m) => new Map(m).set(f.time, r.path as string))
                    setShots((m) => new Map(m).set(f.time, comfyViewUrl(r.path as string, r.path)))
                  } else if (r.error) {
                    setFailed((m) => new Map(m).set(f.time, r.error as string))
                  }
                }}
              >
                {fixing === f.time ? 'Repainting…' : fixed.has(f.time) ? 'Fix again' : 'Fix this face'}
              </button>
            )}
            {failed.get(f.time) && <p className="error">{failed.get(f.time)}</p>}
          </div>
        ))}
      </div>
      {references.length > 0 && (
        <>
          <p className="empty">Compared against:</p>
          <div className="worst-grid">
            {references.map((r) => (
              <div className="worst-card" key={r.path}>
                <img className="worst-shot" src={comfyViewUrl(r.path)} alt={r.label} />
                <p className="empty">{r.label}</p>
              </div>
            ))}
          </div>
        </>
      )}
    </>
  )
}
