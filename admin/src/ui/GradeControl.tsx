/**
 * "Grade this" on a result card.
 *
 * Collapsed to a single button until you want it, because it hangs off every
 * clip and every edit and a permanently-expanded palette row would bury the
 * thing it is attached to. Opening it loads the palette list; the swatch strip
 * beside each name is the point - a look is chosen by looking at it, not by
 * reading its name.
 */
import { useEffect, useState } from 'react'
import { type Movie } from '../insforge'
import { NotInstalled } from './NotInstalled'
import { hasFlow } from '../modules'
import { loadPalettes, type Palette } from '../palettes'
import { gradeStill, gradeClip } from '../grade'

type Props = {
  movie: Movie
  /** A clip grades through ffmpeg; a still grades on the canvas. */
  kind: 'image' | 'clip'
  /** Clip id for 'clip'; the output image path for 'image'. */
  target: string
  /** Only used for stills, to label the reference on the recorded edit. */
  label?: string
  /** Called after a successful grade so the panel can refresh its list. */
  onGraded?: () => void
}

export function GradeControl({ movie, kind, target, label, onGraded }: Props) {
  const [open, setOpen] = useState(false)
  const [palettes, setPalettes] = useState<Palette[]>([])
  const [picked, setPicked] = useState('')
  const [strength, setStrength] = useState(0.6)
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    // Loaded on open rather than on mount: this component is rendered once per
    // card, and a grid of thirty clips must not fire thirty palette queries.
    if (!open || palettes.length) return
    loadPalettes(movie.id).then(setPalettes)
  }, [open, movie.id, palettes.length])

  async function run() {
    const pal = palettes.find((p) => p.id === picked)
    if (!pal) return
    setBusy(true)
    setError(null)
    setDone(null)
    try {
      const r =
        kind === 'clip'
          ? await gradeClip(movie, pal, target, strength)
          : await gradeStill(movie, pal, target, label ?? 'source', strength)
      setDone(r.note)
      onGraded?.()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  // This control belongs to the colour module, which may not be installed:
  // it appears on cards owned by other modules. Without its flow it says so
  // rather than offering a button that cannot work.
  if (!hasFlow(import.meta.env.VITE_APPLY_LUT_ID)) {
    return <NotInstalled module="colour" feature="Grade" inline />
  }

  if (!open) {
    // A plain text pill, matching the buttons it sits beside. An icon here
    // wrapped onto a second line and made the button a different shape from
    // "Load settings" and "Delete" in the same row.
    return (
      <button
        type="button"
        className="grade-toggle"
        onClick={() => setOpen(true)}
        title="Apply a colour palette to a copy"
      >
        Grade
      </button>
    )
  }

  return (
    <div className="grade-inline">
      <div className="grade-palettes">
        {palettes.length === 0 && <p className="empty">Loading palettes…</p>}
        {palettes.map((p) => (
          <button
            type="button"
            key={p.id}
            className={'grade-chip' + (picked === p.id ? ' picked' : '')}
            onClick={() => setPicked(picked === p.id ? '' : p.id)}
            title={p.description ?? p.name}
          >
            <span className="grade-chip-strip">
              {p.swatches.map((c, i) => (
                <span key={i} style={{ background: c }} />
              ))}
            </span>
            {p.name}
          </button>
        ))}
      </div>
      <div className="grade-inline-row">
        <label>
          Strength{' '}
          <input
            className="grade-strength"
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={strength}
            onChange={(e) => setStrength(Number(e.target.value))}
          />
          <span className="badge">{Math.round(strength * 100)}%</span>
        </label>
        <button type="button" disabled={!picked || busy} onClick={run}>
          {busy ? 'Grading…' : 'Apply'}
        </button>
        <button
          type="button"
          onClick={() => {
            setOpen(false)
            setDone(null)
            setError(null)
          }}
        >
          Close
        </button>
      </div>
      {/* The graded copy is shown here rather than only appearing further down
          the list, so it is obvious the original was not overwritten. */}
      {done && <p className="empty">{done}</p>}
      {error && <p className="error">{error}</p>}
    </div>
  )
}
