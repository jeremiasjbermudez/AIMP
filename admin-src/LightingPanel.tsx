import { useEffect, useState } from 'react'
import { Trash2 } from 'lucide-react'
import { comfyViewUrl, type Movie } from './insforge'
import { loadImageSources, toPickerGroups, type ImageSource } from './imageSources'
import { ImageSelect } from './ui/ImageSelect'
import {
  loadLightingPresets,
  saveLightingPreset,
  deleteLightingPreset,
  relightImage,
  lightingThumbUrl,
  lightingInstruction,
  loadPreviews,
  setPreview,
  relightSize,
  type LightingPreset
} from './lighting'

/**
 * Relight: choosing how a shot is lit, before it moves.
 *
 * Deliberately shaped like the Color Palette tab, because they are the two
 * halves of the same job in the order a production does them - light the scene,
 * then grade it. What they cannot share is the mechanism. Colour is a function
 * of pixel value, so a grade fits in a LUT; lighting is spatial, so it has to
 * be generated.
 *
 * A preset lights ONE STILL. That is not a shortcut - it is the finding that
 * made the feature worth building. A relit frame handed to i2v keeps its
 * lighting almost exactly: across 124 frames the left/right falloff held at
 * ~8.7 against 1.03 for the flat original, and mean luminance moved under one
 * unit in 255. Relighting every frame instead would strobe.
 */
export function LightingPanel({ movie }: { movie: Movie }) {
  const [presets, setPresets] = useState<LightingPreset[]>([])
  const [sources, setSources] = useState<ImageSource[]>([])
  const [targetImage, setTargetImage] = useState('')
  const [picked, setPicked] = useState('')
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [results, setResults] = useState<{ path: string; preset: string; presetId: string }[]>([])
  const [previews, setPreviews] = useState<Map<string, string>>(new Map())
  const [rendering, setRendering] = useState<string | null>(null)

  // Writing your own setup.
  const [draftName, setDraftName] = useState('')
  const [draftInstruction, setDraftInstruction] = useState('')

  async function refresh() {
    const [ps, pv] = await Promise.all([loadLightingPresets(movie.id), loadPreviews(movie.id)])
    setPresets(ps)
    setPreviews(pv)
  }

  useEffect(() => {
    refresh()
    loadImageSources(movie.id).then(setSources)
    setResults([])
    setTargetImage('')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [movie.id])

  const pickerGroups = toPickerGroups(sources)
  const chosen = presets.find((p) => p.id === picked) ?? null
  const source = sources.find((s) => s.id === targetImage) ?? null

  async function handleRelight() {
    if (!chosen || !source) return
    setBusy(true)
    setError(null)
    setStatus('Relighting…')
    try {
      const r = await relightImage(movie, chosen, source.path, source.label)
      setResults((prev) => [{ path: r.outputPath, preset: chosen.name, presetId: chosen.id }, ...prev])
      setStatus(`Relit with ${chosen.name}. It is in the Edits group — pick it as a first frame on Image to Video.`)
      loadImageSources(movie.id).then(setSources)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setStatus(null)
    } finally {
      setBusy(false)
    }
  }

  /** Promote a relit result to be this movie's gallery picture for that setup. */
  async function handleUseAsPreview(presetId: string, path: string) {
    const r = await setPreview(movie.id, presetId, path)
    if ('error' in r && r.error) setError(r.error)
    else refresh()
  }

  /**
   * Render the whole library from one picture.
   *
   * Sequential, not parallel: ComfyUI runs one job at a time anyway, and firing
   * twelve at once just fills its queue with work that cannot be cancelled if
   * the first result shows the source was a poor choice. Presets that already
   * have a preview are skipped, so this is resumable and re-running it is cheap.
   */
  async function handleRenderPreviews() {
    if (!source) return
    // Measured once, from the same picture every preview uses, so the gallery
    // is a uniform grid and no preview is a recomposition.
    const full = await relightSize(source.path)
    const shrink = Math.min(1, 640 / Math.max(full.w, full.h))
    const previewSize = {
      w: Math.max(256, Math.round((full.w * shrink) / 16) * 16),
      h: Math.max(256, Math.round((full.h * shrink) / 16) * 16)
    }
    const todo = presets.filter((p) => !previews.has(p.id))
    if (todo.length === 0) {
      setStatus('Every setup already has a preview. Delete one to re-render it.')
      return
    }
    setError(null)
    for (let i = 0; i < todo.length; i++) {
      const p = todo[i]
      setRendering(`${p.name} (${i + 1} of ${todo.length})`)
      try {
        const r = await relightImage(movie, p, source.path, source.label, previewSize)
        await setPreview(movie.id, p.id, r.outputPath)
        setPreviews((prev) => new Map(prev).set(p.id, r.outputPath))
      } catch (e) {
        setError(`${p.name}: ${e instanceof Error ? e.message : String(e)}`)
        break
      }
    }
    setRendering(null)
    setStatus('Previews rendered.')
    loadImageSources(movie.id).then(setSources)
  }

  async function handleSaveDraft() {
    if (!draftName.trim() || !draftInstruction.trim()) return
    const r = await saveLightingPreset(movie, {
      name: draftName.trim(),
      instruction: draftInstruction.trim()
    })
    if ('error' in r && r.error) setError(r.error)
    else {
      setDraftName('')
      setDraftInstruction('')
      refresh()
    }
  }

  async function handleDelete(p: LightingPreset) {
    const r = await deleteLightingPreset(p)
    if ('error' in r && r.error) setError(r.error)
    else refresh()
  }

  return (
    <div>
      <p>
        How a shot is lit, chosen before it moves. A preset relights a still; hand that still to Image
        to Video and the clip inherits the lighting — which is how a set works, and how this was
        measured to behave. Lighting and colour compose: light here, grade on Color Palette.
      </p>

      <h4>Relight a picture</h4>
      <p className="empty">
        Relights a copy — the original is never touched. Takes about twenty seconds.
      </p>
      <div className="upload-form">
        <ImageSelect
          value={targetImage}
          groups={pickerGroups}
          placeholder="Pick an image…"
          onValueChange={setTargetImage}
        />
        <button type="button" disabled={!picked || !source || busy} onClick={handleRelight}>
          {busy ? 'Relighting…' : 'Relight'}
        </button>
        {chosen && <span className="badge">{chosen.name}</span>}
      </div>
      <div className="upload-form">
        <button type="button" disabled={!source || rendering !== null || busy} onClick={handleRenderPreviews}>
          {rendering ? `Rendering ${rendering}…` : 'Render previews for the library'}
        </button>
        <span className="empty">
          Relights the chosen picture with every setup that has no preview yet, small and one at a
          time. About twenty seconds each.
        </span>
      </div>
      {!picked && <p className="empty">Pick a setup from the library below.</p>}
      {status && status !== 'Relighting…' && <p className="empty">{status}</p>}
      {error && <p className="error">{error}</p>}

      {results.length > 0 && (
        <div className="clip-grid">
          {results.map((r, i) => (
            <div className="beat-card" key={i}>
              <p>
                <span className="badge">{r.preset}</span>
              </p>
              <img className="edit-output" src={comfyViewUrl(r.path, r.path)} alt={r.preset} />
              <div className="edit-ref-actions">
                <button type="button" onClick={() => handleUseAsPreview(r.presetId, r.path)}>
                  Use as preview
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      <h4>Lighting library</h4>
      <p className="empty">
        {chosen
          ? `Using “${chosen.name}”. Click it again to clear.`
          : 'Click a setup to use it. Real lighting vocabulary, because that is what the models understand.'}
      </p>
      <div className="palette-grid">
        {presets.map((p) => {
          const thumb = lightingThumbUrl(p, previews)
          return (
            <div
              className={'palette-card' + (picked === p.id ? ' picked' : '')}
              key={p.id}
              role="button"
              tabIndex={0}
              onClick={() => setPicked(picked === p.id ? '' : p.id)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  setPicked(picked === p.id ? '' : p.id)
                }
              }}
            >
              {thumb ? (
                <img className="palette-thumb" src={thumb} alt="" />
              ) : (
                <div className="palette-thumb light-chip-blank" />
              )}
              <div className="palette-card-head">
                <strong>{p.name}</strong>
                {p.is_builtin && <span className="badge">built in</span>}
                {!p.is_builtin && (
                  <button
                    type="button"
                    className="ref-remove"
                    title="Delete"
                    onClick={(e) => {
                      e.stopPropagation()
                      handleDelete(p)
                    }}
                  >
                    <Trash2 size={14} />
                  </button>
                )}
              </div>
              {p.description && <p className="empty">{p.description}</p>}
            </div>
          )
        })}
      </div>

      <h4>Write your own</h4>
      <p className="empty">
        One sentence describing the light, nothing else — the scope fence (
        <em>same subjects, poses, clothing and framing</em>) is added automatically. Name only the
        light, never the effect it produces: a preset that said “leaving a small lit triangle on the
        cheek” made the model draw a glowing triangle on her face.
      </p>
      <div className="upload-form">
        <input
          type="text"
          placeholder="Name it"
          value={draftName}
          onChange={(e) => setDraftName(e.target.value)}
        />
        <button
          type="button"
          disabled={!draftName.trim() || !draftInstruction.trim()}
          onClick={handleSaveDraft}
        >
          Save setup
        </button>
      </div>
      <textarea
        className="prompt-editor"
        rows={2}
        placeholder="Relight: a single hard practical from frame left, deep falloff into shadow on the right."
        value={draftInstruction}
        onChange={(e) => setDraftInstruction(e.target.value)}
      />
      {chosen && (
        <p className="empty">
          <strong>{chosen.name}</strong> sends: {lightingInstruction(chosen)}
        </p>
      )}
    </div>
  )
}
