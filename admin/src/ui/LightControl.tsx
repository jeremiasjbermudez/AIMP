/**
 * "Light" on a result card.
 *
 * Relights a copy and files it as an edit, which puts it straight into the
 * Edits group of every image picker - including the i2v first-frame picker.
 * That is the whole workflow: light the still, then roll. A relit frame carries
 * its lighting through an i2v render almost unchanged, so the clip inherits the
 * look without anything having to relight video.
 *
 * Collapsed until asked for, like GradeControl, because it hangs off every card
 * and an always-open preset list would bury the picture it belongs to.
 */
import { useEffect, useState } from 'react'
import { type Movie } from '../insforge'
import { NotInstalled } from './NotInstalled'
import { hasFlow } from '../modules'
import {
  loadLightingPresets,
  relightImage,
  lightingThumbUrl,
  loadPreviews,
  type LightingPreset
} from '../lighting'

type Props = {
  movie: Movie
  /** The image to relight, as a ComfyUI output path. */
  sourcePath: string
  label?: string
  /** Called after a successful relight so the panel can refresh its list. */
  onRelit?: (outputPath: string) => void
}

export function LightControl({ movie, sourcePath, label, onRelit }: Props) {
  const [open, setOpen] = useState(false)
  const [presets, setPresets] = useState<LightingPreset[]>([])
  const [previews, setPreviews] = useState<Map<string, string>>(new Map())
  const [picked, setPicked] = useState('')
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    // Loaded on open, not on mount: this renders once per card, and a grid of
    // thirty must not fire thirty queries.
    if (!open || presets.length) return
    loadLightingPresets(movie.id).then(setPresets)
    loadPreviews(movie.id).then(setPreviews)
  }, [open, movie.id, presets.length])

  const chosen = presets.find((p) => p.id === picked) ?? null

  async function run() {
    if (!chosen) return
    setBusy(true)
    setError(null)
    setDone(null)
    try {
      const r = await relightImage(movie, chosen, sourcePath, label ?? 'source')
      setDone(`Relit with ${chosen.name}. It is in the Edits group — pick it as a first frame on Image to Video.`)
      onRelit?.(r.outputPath)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  // Relighting is a colour-module idea but it RENDERS through the image-edit
  // flow, so that flow is what decides whether the button can do anything. The
  // placeholder names the module that would supply it.
  if (!hasFlow(import.meta.env.VITE_IMAGE_EDIT_ID)) {
    return <NotInstalled module="imaging" feature="Relight" inline />
  }

  if (!open) {
    return (
      <button type="button" className="grade-toggle" onClick={() => setOpen(true)} title="Relight a copy of this image">
        Light
      </button>
    )
  }

  return (
    <div className="grade-inline">
      <div className="light-presets">
        {presets.length === 0 && <p className="empty">Loading lighting…</p>}
        {presets.map((p) => {
          const thumb = lightingThumbUrl(p, previews)
          return (
            <button
              type="button"
              key={p.id}
              className={'light-chip' + (picked === p.id ? ' picked' : '')}
              onClick={() => setPicked(picked === p.id ? '' : p.id)}
              title={p.description ?? p.name}
            >
              {thumb ? (
                <img className="light-chip-thumb" src={thumb} alt="" />
              ) : (
                <span className="light-chip-thumb light-chip-blank" />
              )}
              <span className="light-chip-name">{p.name}</span>
            </button>
          )
        })}
      </div>
      {/* The description is the useful half while a preset has no preview yet -
          it says what the light is doing, in words a gaffer would use. */}
      {chosen?.description && <p className="empty">{chosen.description}</p>}
      <div className="grade-inline-row">
        <button type="button" disabled={!picked || busy} onClick={run}>
          {busy ? 'Relighting…' : 'Relight'}
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
      {done && <p className="empty">{done}</p>}
      {error && <p className="error">{error}</p>}
    </div>
  )
}
