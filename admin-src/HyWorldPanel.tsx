import { useEffect, useState } from 'react'
import { insforge, comfyViewUrl, type Movie } from './insforge'
import { triggerFlow } from './flowise'
import { saveUploadToProject, saveSnapshotToProject } from './frames'
import { loadImageSources, toPickerGroups, type ImageSource } from './imageSources'
import { ImageSelect } from './ui/ImageSelect'
import { ClipThumbPicker } from './ui/ClipThumbPicker'
import { Select } from './ui/Select'
import { SplatViewer } from './ui/SplatViewer'
import { PanoViewer } from './ui/PanoViewer'
import { IMAGE_ACCEPT } from './storage'

// The flow records pano_path with Windows separators after the first segment
// (output/terst\hyworld\...), which comfyViewUrl would read as one long filename.
const slashed = (p: string) => p.split(String.fromCharCode(92)).join('/')

/**
 * HY-World 2.0 — text, an image, or a video in; a navigable 3D world out.
 *
 * Its own tab because it is its own pipeline. The Panoramas & Worlds tab builds
 * a panorama per scene and feeds Qwen Cleanup, which repairs the splat; that is
 * a different job with a different lifecycle and nothing here touches it.
 *
 * Nothing here asks for a panorama either. HY-World generates one internally as
 * its first stage when the input is text or an image, and skips it entirely
 * when the input is a video.
 */
type HyWorld = {
  id: string
  name: string
  input_mode: Mode
  prompt: string | null
  source_path: string | null
  source_paths: string[] | null
  pano_path: string | null
  ply_path: string | null
  status: string
  error_message: string | null
  created_at: string
}

type Clip = { id: string; video_path: string | null; mode: string; length: number; created_at: string }

// The documented inputs: text and a single image are World Generation;
// several photos and a video are World Reconstruction (WorldMirror 2.0).
type Mode = 'text' | 'image' | 'images' | 'video'
const MODES = [
  { value: 'text', label: 'Text' },
  { value: 'image', label: 'An image' },
  { value: 'images', label: 'Several photos' },
  { value: 'video', label: 'A video' }
]

export function HyWorldPanel({ movie }: { movie: Movie }) {
  const [worlds, setWorlds] = useState<HyWorld[]>([])
  const [sources, setSources] = useState<ImageSource[]>([])
  const [clips, setClips] = useState<Clip[]>([])
  const [mode, setMode] = useState<Mode>('text')
  // Several photos: an ordered list of picture ids from this movie.
  const [viewIds, setViewIds] = useState<string[]>([])
  const [name, setName] = useState('')
  const [prompt, setPrompt] = useState('')
  const [imageId, setImageId] = useState('')
  const [clipId, setClipId] = useState('')
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [viewing, setViewing] = useState<{ kind: 'splat' | 'pano'; world: HyWorld } | null>(null)

  /** Splat snapshots go to Splat Snapshots, panorama ones to Frames - both in every picker. */
  async function handleSnapshot(file: File) {
    const w = viewing?.world
    const kind = viewing?.kind ?? 'splat'
    setViewing(null)
    setError(null)
    const r = await saveSnapshotToProject(movie, file, {
      kind,
      label: `${w?.name ?? 'world'} ${kind === 'splat' ? 'splat' : 'panorama'}`
    })
    if ('error' in r) {
      setError(r.error)
      return
    }
    setNote(kind === 'splat' ? 'Saved to Splat Snapshots.' : 'Saved to Panorama Snapshots.')
    loadImageSources(movie.id).then(setSources)
  }

  async function load() {
    const [w, c] = await Promise.all([
      insforge.database.from('hyworlds').select('*').eq('movie_id', movie.id)
        .order('created_at', { ascending: false }),
      insforge.database.from('minimax_clips').select('id,video_path,mode,length,created_at')
        .eq('movie_id', movie.id).eq('status', 'complete').order('created_at', { ascending: false })
    ])
    setWorlds((w.data ?? []) as HyWorld[])
    setClips(((c.data ?? []) as Clip[]).filter((x) => x.video_path))
  }

  useEffect(() => {
    load()
    loadImageSources(movie.id).then(setSources)
    setImageId('')
    setClipId('')
    setViewIds([])
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [movie.id])

  const image = sources.find((s) => s.id === imageId) ?? null
  const clip = clips.find((c) => c.id === clipId) ?? null
  const views = viewIds.map((id) => sources.find((s) => s.id === id)).filter((s): s is ImageSource => !!s)

  const blocked =
    !name.trim()
      ? 'a name'
      : mode === 'text' && !prompt.trim()
        ? 'a description'
        : mode === 'image' && !image
          ? 'an image'
          : mode === 'images' && views.length < 2
            ? 'at least two photos of the same place'
            : mode === 'video' && !clip
              ? 'a clip'
              : ''

  async function handleBuild() {
    if (blocked) return
    setBusy(true)
    setError(null)
    setNote('Creating…')

    const { data, error: insErr } = await insforge.database
      .from('hyworlds')
      .insert([
        {
          movie_id: movie.id,
          name: name.trim(),
          input_mode: mode,
          prompt: mode === 'text' || mode === 'image' ? prompt.trim() || null : null,
          source_path: mode === 'image' ? image?.path : mode === 'video' ? clip?.video_path : null,
          source_paths: mode === 'images' ? views.map((v) => v.path) : null,
          status: 'queued'
        }
      ])
      .select()
    if (insErr) {
      setError(insErr.message)
      setBusy(false)
      return
    }
    const created = ((data ?? []) as HyWorld[])[0]
    if (!created) {
      setError('The world row was not created.')
      setBusy(false)
      return
    }

    setNote(
      mode === 'video' || mode === 'images'
        ? 'Reconstructing with WorldMirror 2.0…'
        : 'Building: panorama, trajectories, world expansion, then 3DGS training. The training is the long part.'
    )
    await load()
    const r = await triggerFlow(import.meta.env.VITE_HYWORLD_ID, { worldId: created.id })
    setBusy(false)
    setNote(r.state === 'error' ? null : 'Done.')
    if (r.state === 'error') setError(r.message)
    else {
      setName('')
      setPrompt('')
      setViewIds([])
    }
    await load()
  }

  /** Several photos: each file becomes a movie picture and joins the list, in order. */
  async function handleUploadViews(files: File[]) {
    setBusy(true)
    setError(null)
    const added: string[] = []
    for (const [i, file] of files.entries()) {
      setNote(`Uploading ${i + 1} of ${files.length}: ${file.name}…`)
      const up = await saveUploadToProject(movie, file, `upload · ${file.name}`)
      if ('error' in up) {
        setError(`${file.name}: ${up.error}`)
        break
      }
      added.push(up.image_path)
    }
    const next = await loadImageSources(movie.id)
    setSources(next)
    const ids = added.map((p) => next.find((s) => s.path === p)?.id).filter((x): x is string => !!x)
    setViewIds((cur) => [...cur, ...ids.filter((id) => !cur.includes(id))])
    setBusy(false)
    setNote(ids.length ? `Added ${ids.length} photo${ids.length === 1 ? '' : 's'}.` : null)
  }

  /** Upload a picture straight in, for when the source is not already in the project. */
  async function handleUpload(file: File) {
    setBusy(true)
    setError(null)
    setNote(`Uploading ${file.name}…`)
    const up = await saveUploadToProject(movie, file, `upload · ${file.name}`)
    setBusy(false)
    if ('error' in up) {
      setNote(null)
      setError(up.error)
      return
    }
    const next = await loadImageSources(movie.id)
    setSources(next)
    const match = next.find((s) => s.path === up.image_path)
    if (match) {
      setImageId(match.id)
      setNote(`Using ${file.name}.`)
    } else {
      setNote(null)
      setError(`${file.name} was saved to ${up.image_path} but could not be selected.`)
    }
  }

  async function handleRemove(w: HyWorld) {
    // The .ply and the workspace stay on disk - they are large, and this is
    // about the list rather than reclaiming space.
    await insforge.database.from('hyworlds').delete().eq('id', w.id)
    await load()
  }

  return (
    <div>
      {viewing?.kind === 'splat' && viewing.world.ply_path && (
        <SplatViewer
          plyPath={viewing.world.ply_path}
          label={`Splat — ${viewing.world.name}`}
          orient="scene-up"
          onClose={() => setViewing(null)}
          onSnapshot={(file) => handleSnapshot(file)}
        />
      )}
      {viewing?.kind === 'pano' && viewing.world.pano_path && (
        <PanoViewer
          src={comfyViewUrl(slashed(viewing.world.pano_path), viewing.world.id)}
          label={`Panorama — ${viewing.world.name}`}
          onClose={() => setViewing(null)}
          onSnapshot={(file) => handleSnapshot(file)}
        />
      )}

      <p>
        HY-World 2.0, as documented. World Generation (text or a single image): HY-Pano 2.0 makes the
        360 internally, WorldNav plans trajectories, WorldStereo 2.0 expands the world, then WorldMirror
        2.0 and 3DGS training compose it. World Reconstruction (several photos or a video): WorldMirror
        2.0 alone, which predicts the cameras and the Gaussians in one pass.
      </p>

      <h4>Build a world</h4>
      {/* Every control is labelled. Two unlabelled dropdowns side by side - the
          input mode and the picture - are indistinguishable, and clicking the
          wrong one looks like the picker refusing to open. */}
      <div className="camera-row">
        <label>
          Build from
          <Select value={mode} onValueChange={(v) => setMode(v as Mode)} items={MODES} />
        </label>
        <label>
          Name
          <input type="text" placeholder="Name it" value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        {mode === 'image' && (
          <label>
            Picture
            <ImageSelect
              value={imageId}
              groups={toPickerGroups(sources)}
              placeholder="Pick a picture…"
              onValueChange={setImageId}
            />
          </label>
        )}
        {mode === 'image' && (
          <label>
            or upload
            <input
              type="file"
              accept={IMAGE_ACCEPT}
              disabled={busy}
              onChange={(e) => {
                const f = e.target.files?.[0]
                if (f) handleUpload(f)
                e.target.value = ''
              }}
            />
          </label>
        )}
        {mode === 'images' && (
          <label>
            Add a photo
            <ImageSelect
              value=""
              groups={toPickerGroups(sources)}
              placeholder={sources.length ? 'Pick a picture…' : 'Nothing to pick yet'}
              onValueChange={(id) => setViewIds((cur) => (cur.includes(id) ? cur : [...cur, id]))}
            />
          </label>
        )}
        {mode === 'images' && (
          <label>
            or upload several
            <input
              type="file"
              multiple
              accept={IMAGE_ACCEPT}
              disabled={busy}
              onChange={(e) => {
                const fs = Array.from(e.target.files ?? [])
                if (fs.length) handleUploadViews(fs)
                e.target.value = ''
              }}
            />
          </label>
        )}
        <button type="button" disabled={busy || !!blocked} onClick={handleBuild}>
          {busy ? 'Building…' : 'Build the world'}
        </button>
      </div>

      {mode === 'images' && (
        <>
          <p className="empty">
            Photos of the same place from different positions. WorldMirror 2.0 works out where each was
            taken from, so no camera data is needed.
          </p>
          <div className="clip-grid">
            {views.map((v, i) => (
              <div className="beat-card" key={v.id}>
                <img className="shot-preview" src={comfyViewUrl(v.path)} alt={v.label} />
                <p className="empty">
                  {i + 1}. {v.label}
                </p>
                <div className="edit-ref-actions">
                  <button type="button" onClick={() => setViewIds((cur) => cur.filter((x) => x !== v.id))}>
                    Remove
                  </button>
                </div>
              </div>
            ))}
          </div>
        </>
      )}

      {(mode === 'text' || mode === 'image') && (
        <textarea
          className="prompt-editor"
          rows={2}
          placeholder={
            mode === 'image'
              ? 'Optional — anything the picture does not say about the place.'
              : 'A cathedral library at dusk, tall stacks, dust in the light from high windows.'
          }
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
        />
      )}

      {mode === 'video' && (
        <>
          <p className="empty">
            Pick the clip to reconstruct. WorldMirror wants distinct viewpoints, so a shot that moves
            through a space works far better than a locked-off one.
          </p>
          <ClipThumbPicker
            value={clipId}
            onValueChange={setClipId}
            clips={clips.map((c) => ({
              id: c.id,
              video_path: c.video_path,
              label: `${c.mode} · ${c.length} frames`,
              sub: new Date(c.created_at).toLocaleString()
            }))}
            empty="No finished clips in this movie yet."
          />
        </>
      )}

      {image && mode === 'image' && (
        <img className="edit-output" src={comfyViewUrl(image.path)} alt={image.label} />
      )}
      {!busy && blocked && <p className="empty">Building needs: {blocked}.</p>}
      {note && <p className="empty">{note}</p>}
      {error && <p className="error">{error}</p>}

      <h4>Worlds</h4>
      {worlds.length === 0 && <p className="empty">Nothing built yet for {movie.title}.</p>}
      <div className="clip-grid">
        {worlds.map((w) => (
          <div className="beat-card" key={w.id}>
            <p>
              <strong>{w.name}</strong> <span className="badge">{w.input_mode}</span>{' '}
              <span className={w.status === 'failed' ? 'error' : 'badge'}>{w.status}</span>
            </p>
            {w.pano_path && <img className="shot-preview" src={comfyViewUrl(slashed(w.pano_path), w.id)} alt={w.name} />}
            {w.prompt && <p className="empty">{w.prompt}</p>}
            {w.ply_path && <p className="empty">{w.ply_path}</p>}
            {w.error_message && <p className="error">{w.error_message}</p>}
            <div className="edit-ref-actions">
              {w.ply_path && (
                <button type="button" onClick={() => setViewing({ kind: 'splat', world: w })}>
                  View splat
                </button>
              )}
              {w.pano_path && (
                <button type="button" onClick={() => setViewing({ kind: 'pano', world: w })}>
                  View panorama
                </button>
              )}
              <button type="button" className="danger" onClick={() => handleRemove(w)}>
                Remove
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
