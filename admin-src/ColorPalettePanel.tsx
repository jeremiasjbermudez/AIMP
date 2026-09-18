import { useEffect, useRef, useState } from 'react'
import { Trash2 } from 'lucide-react'
import { IMAGE_ACCEPT } from './storage'
import { insforge, comfyViewUrl, type Movie } from './insforge'
import { triggerFlow } from './flowise'
import { loadPalettes, paletteFromImage, savePalette, type Palette } from './palettes'
import { gradeStill, gradeClip } from './grade'
import { Select } from './ui/Select'
import { ImageSelect } from './ui/ImageSelect'
import { loadImageSources, toPickerGroups } from './imageSources'
import { uploadImageToProject } from './frames'

/**
 * The colour palette library.
 *
 * A palette is two things that come from different places: swatches measured
 * off a picture by quantising its pixels here in the browser, and a grading
 * note written by the vision model. Only the second half steers a render - the
 * swatches are for your eyes and for building a LUT later.
 */
export function ColorPalettePanel({ movie }: { movie: Movie }) {
  const [palettes, setPalettes] = useState<Palette[]>([])
  const [sources, setSources] = useState<{ id: string; path: string; label: string; group: string }[]>([])
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [preview, setPreview] = useState<{ src: string; swatches: string[]; path?: string; key?: string } | null>(null)
  const [draftName, setDraftName] = useState('')
  const [draftDesc, setDraftDesc] = useState('')
  const madeUrls = useRef<string[]>([])

  // Applying a palette to something that already exists.
  const [applyTarget, setApplyTarget] = useState<'image' | 'clip'>('image')
  const [targetImage, setTargetImage] = useState('')
  const [targetClip, setTargetClip] = useState('')
  const [applyPalette, setApplyPalette] = useState('')
  const [strength, setStrength] = useState(0.6)
  const [clips, setClips] = useState<{ id: string; label: string; video_path: string }[]>([])
  const [graded, setGraded] = useState<{ kind: 'image' | 'clip'; path: string; palette: string }[]>([])
  const [applyStatus, setApplyStatus] = useState<string | null>(null)

  async function refresh() {
    setPalettes(await loadPalettes(movie.id))
  }

  useEffect(() => {
    refresh()
    loadImageSources(movie.id).then(setSources)
    insforge.database
      .from('minimax_clips')
      .select('id,mode,prompt,video_path,created_at')
      .eq('movie_id', movie.id)
      .eq('status', 'complete')
      .order('created_at', { ascending: false })
      .then(({ data }) => {
        setClips(
          (data ?? [])
            // Graded clips are excluded: grading a grade compounds the look,
            // and they are output, not source material.
            .filter((c: { mode: string; video_path: string | null }) => c.video_path && c.mode !== 'graded')
            .map((c: { id: string; prompt: string; video_path: string; created_at: string }) => ({
              id: c.id,
              video_path: c.video_path,
              label: `${new Date(c.created_at).toLocaleDateString()} — ${String(c.prompt ?? '').slice(0, 46)}`
            }))
        )
      })
    return () => {
      madeUrls.current.forEach(URL.revokeObjectURL)
      madeUrls.current = []
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [movie.id])

  /** Measure the swatches, then ask the model what to call it. */
  async function extract(src: string, opts: { path?: string; key?: string }) {
    setError(null)
    setBusy('extract')
    setDraftName('')
    setDraftDesc('')
    try {
      const swatches = await paletteFromImage(src, 6)
      setPreview({ src, swatches, ...opts })
      const r = await triggerFlow(import.meta.env.VITE_PALETTE_NAMER_ID, {
        imagePath: opts.path,
        storageKey: opts.key,
        movieId: movie.id,
        swatches
      })
      if (r.state !== 'error') {
        const p = JSON.parse(r.message)
        if (p.action === 'complete') {
          setDraftName(p.name)
          setDraftDesc(p.description)
        } else setError(p.error ?? 'The model could not name it.')
      } else setError(r.message)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
    setBusy(null)
  }

  async function handleFile(file: File) {
    setBusy('upload')
    // Into the movie's ComfyUI folder, not InsForge storage. A storage key
    // cannot be shown with a plain <img src>, which is why an uploaded palette
    // saved fine but its picture never appeared in the library.
    const ext = (file.name.split('.').pop() || 'png').replace(/[^a-z0-9]/gi, '') || 'png'
    const up = await uploadImageToProject(movie, file, '_palettes', `palette_${Date.now()}.${ext}`)
    if ('error' in up) {
      setError(up.error)
      setBusy(null)
      return
    }
    await extract(comfyViewUrl(up.image_path), { path: up.image_path })
  }

  async function handleSave() {
    if (!preview || !draftName.trim()) return
    setBusy('save')
    const r = await savePalette(movie, {
      name: draftName.trim(),
      swatches: preview.swatches,
      description: draftDesc.trim(),
      sourcePath: preview.path,
      sourceKey: preview.key
    })
    if ('error' in r && r.error) setError(r.error)
    else {
      setPreview(null)
      setDraftName('')
      setDraftDesc('')
      await refresh()
    }
    setBusy(null)
  }

  /**
   * Grade something that already exists.
   *
   * Images are done here in the browser - it is arithmetic on pixels, so it is
   * instant and nothing is regenerated, which means the subject cannot drift.
   * Clips go to ffmpeg's lut3d through a flow, using a LUT built from the same
   * function, so a graded still and a graded clip agree.
   *
   * Both write a COPY. The original is never touched, because a grade has to
   * stay last: anything downstream that saw graded pixels would learn the look
   * as content and compound it.
   */
  // The grading itself lives in grade.ts, shared with the Grade button on every
  // clip and edit card. One definition, so a still and a clip cannot drift.
  async function handleApply() {
    const pal = palettes.find((x) => x.id === applyPalette)
    if (!pal) return
    setError(null)
    setApplyStatus('Grading…')
    try {
      if (applyTarget === 'image') {
        const src = sources.find((x) => x.id === targetImage)
        if (!src) return
        const r = await gradeStill(movie, pal, src.path, src.label, strength)
        setGraded((g) => [{ kind: 'image', path: r.path, palette: pal.name }, ...g])
        setApplyStatus(r.note)
      } else {
        const clip = clips.find((c) => c.id === targetClip)
        if (!clip) return
        const r = await gradeClip(movie, pal, clip.id, strength)
        setGraded((g) => [{ kind: 'clip', path: r.path, palette: pal.name }, ...g])
        setApplyStatus(r.note)
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setApplyStatus(null)
    }
  }

  async function handleDelete(p: Palette) {
    if (p.is_builtin) return
    await insforge.database.from('color_palettes').delete().eq('id', p.id)
    await refresh()
  }

  const pickerGroups = toPickerGroups(sources)

  return (
    <div>
      <p>
        A look, stored as swatches plus a grading note. The swatches are measured off the picture; the
        note is written by the vision model, and it is the half that actually steers a render.
      </p>

      <h4>Pull a palette from a picture</h4>
      <div className="upload-form">
        <ImageSelect
          value=""
          resetAfterPick
          groups={pickerGroups}
          placeholder="From this movie…"
          onValueChange={(id) => {
            const s = sources.find((x) => x.id === id)
            if (s) extract(comfyViewUrl(s.path), { path: s.path })
          }}
        />
        <label>
          <input
            type="file"
            accept={IMAGE_ACCEPT}
            disabled={busy !== null}
            onChange={(e) => {
              const f = e.target.files?.[0]
              if (f) handleFile(f)
              e.target.value = ''
            }}
          />
        </label>
        {busy === 'extract' && <span className="empty">Reading the colours…</span>}
      </div>
      {error && <p className="error">{error}</p>}

      {preview && (
        <div className="beat-card palette-draft">
          <img className="palette-source" src={preview.src} alt="" />
          <div className="palette-strip">
            {preview.swatches.map((c) => (
              <span key={c} style={{ background: c }} title={c} />
            ))}
          </div>
          <div className="upload-form">
            <input
              type="text"
              placeholder="Name it"
              value={draftName}
              onChange={(e) => setDraftName(e.target.value)}
            />
            <button type="button" disabled={!draftName.trim() || busy !== null} onClick={handleSave}>
              {busy === 'save' ? 'Saving…' : 'Save palette'}
            </button>
            <button type="button" className="danger" onClick={() => setPreview(null)}>
              Discard
            </button>
          </div>
          <textarea
            className="prompt-editor"
            rows={3}
            placeholder="How to grade toward it"
            value={draftDesc}
            onChange={(e) => setDraftDesc(e.target.value)}
          />
        </div>
      )}

      <h4>Apply a palette</h4>
      <p className="empty">
        Grades a copy — the original is never touched. An image is graded here in the browser and is
        instant; a clip goes through ffmpeg with a LUT built from the same maths, so the two agree.
      </p>
      <div className="upload-form">
        <Select
          value={applyTarget}
          onValueChange={(v) => setApplyTarget(v as 'image' | 'clip')}
          items={[
            { value: 'image', label: 'An image' },
            { value: 'clip', label: 'A clip' }
          ]}
        />
        {applyTarget === 'image' ? (
          <ImageSelect
            value={targetImage}
            groups={pickerGroups}
            placeholder="Pick an image…"
            onValueChange={setTargetImage}
          />
        ) : (
          <Select
            value={targetClip}
            onValueChange={setTargetClip}
            placeholder="Pick a clip…"
            items={clips.map((c) => ({ value: c.id, label: c.label }))}
          />
        )}
        <Select
          value={applyPalette}
          onValueChange={setApplyPalette}
          placeholder="Palette…"
          items={palettes.map((p) => ({ value: p.id, label: p.name }))}
        />
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
        <button
          type="button"
          disabled={
            !applyPalette ||
            applyStatus === 'Grading…' ||
            (applyTarget === 'image' ? !targetImage : !targetClip)
          }
          onClick={handleApply}
        >
          {applyStatus === 'Grading…' ? 'Grading…' : 'Apply'}
        </button>
      </div>
      {applyTarget === 'clip' && clips.length === 0 && (
        <p className="empty">No rendered clips in {movie.title} yet.</p>
      )}
      {applyStatus && applyStatus !== 'Grading…' && <p className="empty">{applyStatus}</p>}
      {graded.length > 0 && (
        <div className="clip-grid">
          {graded.map((g, i) => (
            <div className="beat-card" key={i}>
              <p className="empty">{g.palette}</p>
              {g.kind === 'image' ? (
                <img className="edit-output" src={comfyViewUrl(g.path)} alt={g.palette} />
              ) : (
                <video src={comfyViewUrl(g.path)} controls preload="metadata" style={{ width: '100%' }} />
              )}
            </div>
          ))}
        </div>
      )}

      <h4>Palette library</h4>
      <p className="empty">
        {applyPalette
          ? `Using “${palettes.find((p) => p.id === applyPalette)?.name ?? ''}” — set the target in Apply a palette above, then hit Apply. Click it again to clear.`
          : 'Click a palette to use it for grading.'}
      </p>
      <div className="palette-grid">
        {palettes.map((p) => (
          <div
            className={'palette-card' + (applyPalette === p.id ? ' picked' : '')}
            key={p.id}
            role="button"
            tabIndex={0}
            title={applyPalette === p.id ? 'Selected — set the target above and hit Apply' : 'Click to use this palette'}
            onClick={() => setApplyPalette(applyPalette === p.id ? '' : p.id)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                setApplyPalette(applyPalette === p.id ? '' : p.id)
              }
            }}
          >
            {p.source_path ? (
              <img className="palette-thumb" src={comfyViewUrl(p.source_path)} alt="" />
            ) : (
              <div
                className="palette-thumb palette-thumb-swatches"
                style={{ background: `linear-gradient(135deg, ${p.swatches.join(', ')})` }}
              />
            )}
            <div className="palette-strip">
              {p.swatches.map((c, i) => (
                <span key={i} style={{ background: c }} title={c} />
              ))}
            </div>
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
        ))}
      </div>
    </div>
  )
}
