import { useEffect, useState } from 'react'
import { IMAGE_ACCEPT } from './storage'
import { insforge, comfyViewUrl, type Movie, type Scene } from './insforge'
import { triggerFlow, fileToUpload, type RunStatus } from './flowise'
import { ImageSelect, type ImageGroup } from './ui/ImageSelect'
import { deleteAssetFiles, keptNote } from './assets'
import { loadMovieFrames, frameLabel, saveSnapshotToProject } from './frames'
import { SplatViewer } from './ui/SplatViewer'
import { PanoViewer } from './ui/PanoViewer'
import { Select } from './ui/Select'

// Panorama and splat per scene. The Panoramic Generator already accepted a
// custom panorama - it looks for an uploaded image on the request and stores it
// as source 'manual_upload' - there was simply no way to send one from here.

type Pano = {
  id: string
  act_number: number
  scene_number: number
  image_path: string
  seed: number | null
  source: string | null
  updated_at: string
}

type Splat = {
  id: string
  act_number: number
  scene_number: number
  ply_path: string | null
  workspace_name: string | null
  updated_at: string
}

// The opening the operator asked for: panoramas want an explicitly vast,
// centred description, because the model otherwise renders a room whose walls
// crowd the camera and the splat built from it has nowhere to stand.
const PROMPT_STARTER = '360 equirectangular panorama, a vast and highly spacious '

/** One .ply on disk, from the camera flow's `plys` mode. */
type SplatFile = {
  path: string
  workspace: string
  name: string
  step: number | null
  is_backup: boolean
  size_mb: number
  modified: string
  in_use_for: string | null
}

export function WorldPanel({ movie }: { movie: Movie }) {
  const [scenes, setScenes] = useState<Scene[]>([])
  const [panos, setPanos] = useState<Pano[]>([])
  const [splats, setSplats] = useState<Splat[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  // Hand-written panorama prompts, per scene. Empty means "derive it from the
  // scene prose", which is the existing behaviour.
  const [prompts, setPrompts] = useState<Record<string, string>>({})
  // Images from this movie that the vision model can be shown as a guide.
  const [catalogue, setCatalogue] = useState<{ id: string; path: string; label: string; group: string }[]>([])
  const [describing, setDescribing] = useState<string | null>(null)
  // Deleting a panorama is confirmed in place: it is the plate a whole scene is
  // built from, and the splat below it was derived from this image.
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)
  const [confirmDeleteSplat, setConfirmDeleteSplat] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  // How hard the world builder should look at the room, per scene.
  //
  // These are the difference between a set you can only shoot from the
  // middle and one you can put a camera in the corner of. With exploration
  // off - which was the only behaviour until now - WorldStereo never travels,
  // so nothing constrains the geometry in the corners and a camera placed
  // there renders smear. Turning it on for A1S2 took the fused geometry from
  // 1 MB to 20 MB and came back sharp from every bearing.
  const [quality, setQuality] = useState<Record<string, string>>({})
  // Continue the existing world's training from its last checkpoint instead
  // of retraining from scratch. Per scene, off by default.
  const [resume, setResume] = useState<Record<string, boolean>>({})
  const [advanced, setAdvanced] = useState<Record<string, { anchors: string; maxTraj: string; steps: string }>>({})
  const [status, setStatus] = useState<Record<string, RunStatus>>({})

  async function load() {
    setLoading(true)
    const [s, p, v] = await Promise.all([
      insforge.database.from('scenes').select('*').eq('movie_id', movie.id)
        .order('act_number', { ascending: true }).order('scene_number', { ascending: true }),
      insforge.database.from('scene_panos').select('*').eq('movie_id', movie.id),
      insforge.database.from('scene_splats').select('*').eq('movie_id', movie.id)
    ])
    if (s.error) setError(s.error.message)
    setScenes((s.data ?? []) as Scene[])
    setPanos((p.data ?? []) as Pano[])
    setSplats((v.data ?? []) as Splat[])
    setLoading(false)
  }

  useEffect(() => {
    load()
    loadCatalogue()
    setStatus({})
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [movie.id])

  const scopeOf = (s: Scene) => `A${s.act_number}S${s.scene_number}`
  const panoFor = (s: Scene) => panos.find((p) => p.act_number === s.act_number && p.scene_number === s.scene_number)
  const splatFor = (s: Scene) => splats.find((v) => v.act_number === s.act_number && v.scene_number === s.scene_number)

  function report(scope: string, key: string, result: RunStatus) {
    setStatus((prev) => ({ ...prev, [`${scope}-${key}`]: result }))
    setBusy(null)
    load()
  }

  /** Send a custom panorama. The flow stages it into ComfyUI and records it for this scene. */
  async function handleUpload(scene: Scene, file: File) {
    const scope = scopeOf(scene)
    setBusy(`${scope}-upload`)
    setError(null)
    try {
      const upload = await fileToUpload(file)
      // --force so an existing panorama is replaced rather than the flow
      // short-circuiting on "this scene already has one".
      report(scope, 'upload', await triggerFlow(import.meta.env.VITE_PANORAMIC_GENERATOR_ID, `${scope} --force`, [upload]))
    } catch (e) {
      setBusy(null)
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  async function loadCatalogue() {
    const out: { id: string; path: string; label: string; group: string }[] = []
    const { data: chars } = await insforge.database
      .from('characters').select('id,name').eq('movie_id', movie.id).order('name', { ascending: true })
    const ids = (chars ?? []).map((c: { id: string }) => c.id)
    if (ids.length) {
      const { data: imgs } = await insforge.database
        .from('character_images').select('id,character_id,kind,version,image_path')
        .filter('character_id', 'in', `(${ids.join(',')})`).order('version', { ascending: false })
      const byId = new Map((chars ?? []).map((c: { id: string; name: string }) => [c.id, c.name]))
      for (const im of imgs ?? []) {
        if (!im.image_path) continue
        out.push({ id: im.id, path: im.image_path, label: `${byId.get(im.character_id) ?? '?'} — ${im.kind}`, group: 'Characters' })
      }
    }
    const { data: cleanups } = await insforge.database
      .from('qwen_cleanups').select('id,act_number,scene_number,cleaned_image_path')
      .eq('movie_id', movie.id).eq('status', 'complete').order('created_at', { ascending: false })
    for (const c of cleanups ?? []) {
      if (!c.cleaned_image_path) continue
      out.push({ id: `cleanup-${c.id}`, path: c.cleaned_image_path, label: `A${c.act_number}S${c.scene_number} cleanup`, group: 'Cleanups' })
    }
    const { data: edits } = await insforge.database
      .from('image_edits').select('id,prompt,output_path')
      .eq('movie_id', movie.id).eq('status', 'complete').order('created_at', { ascending: false })
    for (const e of edits ?? []) {
      if (!e.output_path) continue
      out.push({ id: `edit-${e.id}`, path: e.output_path, label: String(e.prompt).slice(0, 42), group: 'Edits' })
      }

      // Frames grabbed out of rendered clips - a still from a shot is often the
      // best guide for the panorama of the place it was shot in.
      for (const f of await loadMovieFrames(movie.id)) {
        out.push({ id: `frame-${f.id}`, path: f.image_path, label: frameLabel(f), group: 'Frames' })
    }
    setCatalogue(out)
  }

  // Shows the picture to the multimodal model and puts its description in the
  // prompt box, where it can be edited before anything is generated.
  async function handleDescribe(scene: Scene, imageId: string) {
    const item = catalogue.find((c) => c.id === imageId)
    if (!item) return
    const scope = scopeOf(scene)
    setDescribing(scope)
    setError(null)
    // Forward slashes only: a stored Windows path loses its backslash in
    // transit - JSON reads a backslash-a pair as a control character - and the
    // asks ComfyUI for a subfolder that does not exist.
    const imagePath = item.path.split(String.fromCharCode(92)).join('/')
    const r = await triggerFlow(import.meta.env.VITE_PANO_PROMPT_ID, { imagePath })
    setDescribing(null)
    if (r.state === 'error') {
      setError(r.message)
      return
    }
    try {
      const p = JSON.parse(r.message)
      if (p.error) setError(p.error)
      else if (p.prompt) setPrompts((prev) => ({ ...prev, [scope]: p.prompt }))
    } catch {
      setError(r.message)
    }
  }

  const GUIDE_ORDER = ['Cleanups', 'Edits', 'Characters', 'Frames']
  const guideGroups: ImageGroup[] = GUIDE_ORDER.map((g) => ({
    label: g,
    items: catalogue.filter((c) => c.group === g).map((c) => ({ value: c.id, label: c.label, thumb: comfyViewUrl(c.path) }))
  })).filter((g) => g.items.length > 0)

  // Removes the panorama row for a scene. The rendered file stays in ComfyUI's
  // output folder, which has no delete endpoint - but nothing points at it any
  // more, and the next generate writes a fresh one.
  async function handleDeleteSplat(scene: Scene) {
    const scope = scopeOf(scene)
    setBusy(`${scope}-splat-del`)
    setError(null)
    // The .ply and its backup, read before the row goes. A splat is minutes of
    // GPU time and hundreds of megabytes, so it is worth actually reclaiming.
    const { data: doomed } = await insforge.database
      .from('scene_splats')
      .select('ply_path,backup_path')
      .eq('movie_id', movie.id)
      .eq('act_number', scene.act_number)
      .eq('scene_number', scene.scene_number)
    const { error: delError } = await insforge.database
      .from('scene_splats')
      .delete()
      .eq('movie_id', movie.id)
      .eq('act_number', scene.act_number)
      .eq('scene_number', scene.scene_number)
    if (delError) setError(delError.message)
    else {
      const rows = (doomed ?? []) as { ply_path: string | null; backup_path: string | null }[]
      const r = await deleteAssetFiles(rows.flatMap((d) => [d.ply_path, d.backup_path]))
      const note = keptNote(r)
      if (note) setError(note)
    }
    setBusy(null)
    setConfirmDeleteSplat(null)
    await load()
  }

  async function handleDeletePano(scene: Scene) {
    const scope = scopeOf(scene)
    setBusy(`${scope}-del`)
    setError(null)
    // Read the file location before the row goes, then clean up after it.
    const { data: doomed } = await insforge.database
      .from('scene_panos')
      .select('image_path')
      .eq('movie_id', movie.id)
      .eq('act_number', scene.act_number)
      .eq('scene_number', scene.scene_number)
    const { error: delError } = await insforge.database
      .from('scene_panos')
      .delete()
      .eq('movie_id', movie.id)
      .eq('act_number', scene.act_number)
      .eq('scene_number', scene.scene_number)
    if (delError) setError(delError.message)
    else {
      const r = await deleteAssetFiles((doomed ?? []).map((d: { image_path: string | null }) => d.image_path))
      const note = keptNote(r)
      if (note) setError(note)
    }
    setBusy(null)
    setConfirmDelete(null)
    await load()
  }

  async function handleGenerate(scene: Scene, force: boolean) {
    const scope = scopeOf(scene)
    setBusy(`${scope}-gen`)
    const typed = (prompts[scope] ?? '').trim()
    // A hand-written prompt is passed through as --prompt "...", which the
    // generator uses instead of the scene prose. Quotes are stripped because
    // the flag itself is quote-delimited.
    const args = [force ? `${scope} --force` : scope]
    if (typed) args.push(`--prompt "${typed.replace(/"/g, "'")}"`)
    report(scope, 'gen', await triggerFlow(import.meta.env.VITE_PANORAMIC_GENERATOR_ID, args.join(' ')))
  }

  async function handleWorld(scene: Scene, force: boolean) {
    const scope = scopeOf(scene)
    setBusy(`${scope}-world`)
    // Flags, not JSON: the whole contract for this flow is a string, the way
    // every other flow here takes one. A bare scope still means what it
    // always did.
    const args = [force ? `${scope} --force` : scope]
    const q = quality[scope] ?? 'standard'
    args.push(`--quality ${q}`)
    if (resume[scope]) args.push('--resume')
    const adv = advanced[scope]
    if (adv) {
      // Anything typed in wins over the preset, so a preset plus one changed
      // number does what it looks like it does.
      if (adv.anchors.trim()) args.push(`--anchors ${adv.anchors.trim()}`)
      if (adv.maxTraj.trim()) args.push(`--max-traj ${adv.maxTraj.trim()}`)
      if (adv.steps.trim()) args.push(`--steps ${adv.steps.trim()}`)
    }
    report(scope, 'world', await triggerFlow(import.meta.env.VITE_WORLD_BUILDER_ID, args.join(' ')))
  }

  /**
   * Every .ply on disk for this movie, and which one each scene is set to.
   *
   * A world keeps its history: each training step it saved, the backups a
   * forced rebuild made, and the worlds built under other workspace names. The
   * scene record points at exactly one of them, and until now that was the only
   * one anything could open - so a continued training could not be compared
   * against what it continued, and a rebuild that went worse could not be
   * looked at before deciding to go back.
   *
   * The list comes from the camera flow because nothing in the browser can see
   * that deep into ComfyUI's output folder.
   */
  const [splatFiles, setSplatFiles] = useState<SplatFile[]>([])
  const [splatChoice, setSplatChoice] = useState<Record<string, string>>({})
  const [splatListNote, setSplatListNote] = useState<string | null>(null)
  const [switching, setSwitching] = useState<string | null>(null)

  async function loadSplatFiles() {
    setSplatListNote(null)
    const r = await triggerFlow(import.meta.env.VITE_SPLAT_CAMERA_ID, { mode: 'plys', movieId: movie.id })
    if (r.state === 'error') {
      setSplatListNote(r.message)
      return
    }
    try {
      const out = JSON.parse(r.message) as { splats?: SplatFile[]; reason?: string }
      if (!out.splats) throw new Error(out.reason ?? 'The splat list came back empty.')
      setSplatFiles(out.splats)
    } catch (e) {
      setSplatListNote(e instanceof Error ? e.message : String(e))
    }
  }

  useEffect(() => {
    loadSplatFiles()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [movie.id])

  /**
   * Point a scene at a different .ply.
   *
   * The floor plan moves with it, because plates are rendered from the plan's
   * ply and a plan left behind would keep rendering the previous world. Only
   * plans for the SAME workspace are moved: a plan surveyed in another world
   * measured different walls, and its landmarks would be nonsense here.
   */
  async function useSplat(scene: Scene, file: SplatFile) {
    const scope = scopeOf(scene)
    setSwitching(scope)
    try {
      const { error: splatError } = await insforge.database
        .from('scene_splats')
        .update({ ply_path: file.path, workspace_name: file.workspace })
        .eq('movie_id', movie.id)
        .eq('act_number', scene.act_number)
        .eq('scene_number', scene.scene_number)
      if (splatError) throw new Error(splatError.message)
      const { error: planError } = await insforge.database
        .from('scene_floor_plans')
        .update({ ply_path: file.path })
        .eq('movie_id', movie.id)
        .eq('act_number', scene.act_number)
        .eq('scene_number', scene.scene_number)
        .eq('world_name', file.workspace)
      if (planError) throw new Error(planError.message)
      const { data } = await insforge.database.from('scene_splats').select('*').eq('movie_id', movie.id)
      setSplats((data ?? []) as Splat[])
      await loadSplatFiles()
    } catch (e) {
      setSplatListNote(e instanceof Error ? e.message : String(e))
    } finally {
      setSwitching(null)
    }
  }

  // Which panorama or splat is open, if any. One piece of state for both:
  // they are different things to look at, not two modes of one viewer, and
  // only ever one is open at a time.
  const [viewing, setViewing] = useState<
    { kind: 'pano' | 'splat'; scope: string; path: string } | null
  >(null)

  /**
   * A view saved out of either viewer goes into the movie as a frame, so it
   * turns up in every picker - Image Edit's references, the Director's Set
   * dropdown, Ref to Video. That is the whole point of being able to fly
   * around a splat: you stop at an angle you like and take it with you.
   */
  async function keepSnapshot(kind: 'pano' | 'splat', scope: string, png: Blob) {
    const saved = await saveSnapshotToProject(movie, png, {
      kind: kind === 'splat' ? 'splat' : 'pano',
      label: `${scope} ${kind}`
    })
    // Only a failure needs saying: the snapshot appearing in the pickers is
    // its own confirmation.
    if ('error' in saved) setError(saved.error)
  }

  if (loading) return <p>Loading scenes…</p>
  if (scenes.length === 0) {
    return (
      <div>
        <h3>Panoramas & Worlds</h3>
        <p className="empty">
          No scenes yet for {movie.title}. Build the scenes first — on the Screenplay tab, or by
          running the Scene Import.
        </p>
      </div>
    )
  }

  return (
    <div>
      {/* One viewer open at a time. orient="scene-up" matters: world
          generation picks an up axis per scene and records it beside the .ply,
          and without this the room arrives upside down - which is exactly what
          happened in Qwen Cleanup for weeks because the prop was missing there. */}
      {viewing?.kind === 'splat' && (
        <SplatViewer
          plyPath={viewing.path}
          label={`Splat — ${viewing.scope}`}
          orient="scene-up"
          onClose={() => setViewing(null)}
          onSnapshot={(file) => keepSnapshot('splat', viewing.scope, file)}
        />
      )}
      {viewing?.kind === 'pano' && (
        <PanoViewer
          src={comfyViewUrl(viewing.path)}
          label={`Panorama — ${viewing.scope}`}
          onClose={() => setViewing(null)}
          onSnapshot={(file) => keepSnapshot('pano', viewing.scope, file)}
        />
      )}

      <h3>Panoramas & Worlds</h3>
      <p className="empty">
        Each scene needs a panorama before the world builder can turn it into a splat. Generate one,
        or upload your own if you would rather use a specific image.
      </p>
      {error && <p className="error">{error}</p>}

      {scenes.map((scene) => {
        const scope = scopeOf(scene)
        const pano = panoFor(scene)
        const splat = splatFor(scene)
        const genStatus = status[`${scope}-gen`] ?? status[`${scope}-upload`]
        const worldStatus = status[`${scope}-world`]

        return (
          <div className="beat-card" key={scene.id}>
            <p>
              <span className="badge">{scope}</span>{' '}
              <strong>{scene.location_name ?? scene.scene_heading ?? '(no location)'}</strong>
              {pano && <span className="badge">{pano.source ?? 'generated'}</span>}
              {splat?.ply_path && <span className="badge">splat ready</span>}
            </p>

            {pano ? (
              <img className="shot-preview" src={comfyViewUrl(pano.image_path)} alt={`${scope} panorama`} />
            ) : (
              <p className="empty">No panorama yet.</p>
            )}

            <div className="upload-form pano-guide">
              <ImageSelect
                value=""
                resetAfterPick
                disabled={describing === scope || guideGroups.length === 0}
                placeholder={describing === scope ? 'Looking at it…' : 'Describe from an image…'}
                groups={guideGroups}
                onValueChange={(id) => handleDescribe(scene, id)}
              />
              <span className="empty">Qwen looks at the picture and writes the description below.</span>
            </div>
            <label className="empty pano-prompt">
              Describe it yourself (optional) — leave empty to use the scene prose
              <textarea
                rows={3}
                placeholder={PROMPT_STARTER + 'stone courtyard under a red moon, distant colonnades on every side'}
                value={prompts[scope] ?? ''}
                onChange={(e) => setPrompts((p) => ({ ...p, [scope]: e.target.value }))}
                onFocus={(e) => {
                  // Seed the opening on first focus so the required framing is there to
                  // continue rather than something to remember.
                  if (!e.target.value) setPrompts((p) => ({ ...p, [scope]: PROMPT_STARTER }))
                }}
              />
            </label>

            <div className="upload-form">
              <button
                type="button"
                disabled={busy !== null}
                onClick={() => handleGenerate(scene, Boolean(pano))}
              >
                {busy === `${scope}-gen` ? 'Generating…' : pano ? 'Regenerate' : 'Generate panorama'}
              </button>
              {pano &&
                (confirmDelete === scope ? (
                  <>
                    <span className="empty">Delete this panorama?{splat?.ply_path ? ' Its splat stays and will no longer match.' : ''}</span>
                    <button type="button" className="danger" disabled={busy !== null} onClick={() => handleDeletePano(scene)}>
                      {busy === `${scope}-del` ? 'Deleting…' : 'Delete'}
                    </button>
                    <button type="button" onClick={() => setConfirmDelete(null)}>Cancel</button>
                  </>
                ) : (
                  <button type="button" className="danger" disabled={busy !== null} onClick={() => setConfirmDelete(scope)}>
                    Delete panorama
                  </button>
                ))}
              {splat?.ply_path &&
                (confirmDeleteSplat === scope ? (
                  <>
                    <span className="empty">Delete this splat and its .ply?</span>
                    <button
                      type="button"
                      className="danger"
                      disabled={busy !== null}
                      onClick={() => handleDeleteSplat(scene)}
                    >
                      {busy === `${scope}-splat-del` ? 'Deleting…' : 'Delete'}
                    </button>
                    <button type="button" onClick={() => setConfirmDeleteSplat(null)}>
                      Cancel
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    className="danger"
                    disabled={busy !== null}
                    onClick={() => setConfirmDeleteSplat(scope)}
                  >
                    Delete splat
                  </button>
                ))}

              <label className="world-upload">
                {busy === `${scope}-upload` ? 'Uploading…' : 'Use my own image'}
                <input
                  type="file"
                  accept={IMAGE_ACCEPT}
                  disabled={busy !== null}
                  onChange={(e) => {
                    const f = e.target.files?.[0]
                    if (f) handleUpload(scene, f)
                    e.target.value = ''
                  }}
                />
              </label>

              {/* Look at what has been built. A panorama is a place to stand and
                  turn around in; a splat is a place to walk. Both hand a saved
                  view back to the movie as a frame, so an angle you like in here
                  becomes a reference everywhere else. */}
              {pano && (
                <button
                  type="button"
                  onClick={() => setViewing({ kind: 'pano', scope, path: pano.image_path })}
                >
                  View panorama
                </button>
              )}
              {splat?.ply_path && (
                <button
                  type="button"
                  onClick={() =>
                    setViewing({ kind: 'splat', scope, path: splatChoice[scope] || (splat.ply_path as string) })
                  }
                >
                  View splat
                </button>
              )}

              <button
                type="button"
                disabled={busy !== null || !pano}
                title={pano ? undefined : 'Needs a panorama first'}
                onClick={() => handleWorld(scene, Boolean(splat?.ply_path))}
              >
                {busy === `${scope}-world`
                  ? 'Building…'
                  : splat?.ply_path
                    ? resume[scope]
                      ? 'Continue training'
                      : 'Rebuild world'
                    : 'Build world'}
              </button>
              {splat?.ply_path && (
                <label className="empty">
                  <input
                    type="checkbox"
                    checked={Boolean(resume[scope])}
                    onChange={(e) => setResume((r) => ({ ...r, [scope]: e.target.checked }))}
                  />{' '}
                  Continue from checkpoint
                </label>
              )}
            </div>
            {resume[scope] && splat?.ply_path && (
              <p className="empty">
                Keeps the trained world and trains it further from its last checkpoint. New trajectories are
                expanded and added; the coordinate frame stays the same, so the floor plan and shot cameras still
                hold. Steps below mean how many more (2000 if blank). The current ply is backed up first.
              </p>
            )}

            {/* Which .ply. Every training this world has saved, its backups,
                and any world built for this scene under another workspace
                name - so a continued training can be compared with what it
                continued before the scene is switched over to it. */}
            {splat?.ply_path && splatFiles.length > 1 && (
              <details className="world-advanced">
                <summary className="empty">
                  Splat version — {splatFiles.length} on disk
                  {splatChoice[scope] && splatChoice[scope] !== splat.ply_path ? ' · viewing another' : ''}
                </summary>
                <div className="upload-form">
                  <label className="empty">
                    File
                    <Select
                      value={splatChoice[scope] || (splat.ply_path as string)}
                      onValueChange={(v) => setSplatChoice((c) => ({ ...c, [scope]: v }))}
                      items={splatFiles.map((f) => ({
                        value: f.path,
                        label: `${f.modified} · ${f.size_mb} MB · ${f.workspace}${f.is_backup ? ' · backup' : ''}${
                          f.path === splat.ply_path ? ' · in use here' : f.in_use_for ? ` · in use for ${f.in_use_for}` : ''
                        }`
                      }))}
                    />
                  </label>
                  <button
                    type="button"
                    disabled={!splatChoice[scope] || splatChoice[scope] === splat.ply_path || switching === scope}
                    title="Point this scene, and its floor plan, at the selected file"
                    onClick={() => {
                      const file = splatFiles.find((f) => f.path === splatChoice[scope])
                      if (file) useSplat(scene, file)
                    }}
                  >
                    {switching === scope ? 'Switching…' : 'Use this one'}
                  </button>
                  <button type="button" onClick={loadSplatFiles}>
                    Rescan
                  </button>
                </div>
                <p className="empty">
                  Viewing only changes what "View splat" opens. "Use this one" points the scene and its floor plan
                  at the file, so the Camera tab renders its plates from it. Nothing is deleted either way.
                </p>
                {splatListNote && <p className="error">{splatListNote}</p>}
              </details>
            )}

            {/* How hard to look at the room.
                The cost is almost entirely trajectories: each one is a run of
                WorldStereo generations plus the WorldMirror reconstructions
                after it, so that number is what decides twenty minutes against
                three hours. Times are from this machine on A1S2. */}
            <div className="upload-form">
              <label className="empty">
                World detail
                <Select
                  value={quality[scope] ?? 'standard'}
                  onValueChange={(v) => setQuality((q) => ({ ...q, [scope]: v }))}
                  items={[
                    { value: 'fast', label: 'Fast — no exploring, ~15 min' },
                    { value: 'standard', label: 'Standard — explores the corners, ~35 min' },
                    { value: 'detailed', label: 'Detailed — plus object passes, ~1.5 h' },
                    { value: 'exhaustive', label: 'Exhaustive — uncapped, 3 h+' }
                  ]}
                />
              </label>
              <span className="empty">
                {(quality[scope] ?? 'standard') === 'fast'
                  ? 'What every world here was built with until now: no navigation, no anchor scans. Sharp from the middle of the room, smeared from the corners.'
                  : (quality[scope] ?? 'standard') === 'standard'
                    ? 'WorldNav walks into the unseen parts and WorldStereo invents views from them, so a camera can stand in a corner.'
                    : (quality[scope] ?? 'standard') === 'detailed'
                      ? 'Adds close passes on the objects the vision model finds, and trains for longer — more views need more training steps to stay sharp.'
                      : 'No cap on trajectories. It will keep exploring until the planner runs out of places to go.'}
              </span>
            </div>

            <details className="world-advanced">
              <summary className="empty">Advanced — override individual numbers</summary>
              <div className="upload-form">
                <label className="empty">
                  Anchor scans
                  <input
                    type="text"
                    size={4}
                    placeholder="3"
                    value={advanced[scope]?.anchors ?? ''}
                    onChange={(e) =>
                      setAdvanced((a) => ({
                        ...a,
                        [scope]: { anchors: e.target.value, maxTraj: a[scope]?.maxTraj ?? '', steps: a[scope]?.steps ?? '' }
                      }))
                    }
                  />
                </label>
                <label className="empty">
                  Max trajectories
                  <input
                    type="text"
                    size={4}
                    placeholder="14"
                    value={advanced[scope]?.maxTraj ?? ''}
                    onChange={(e) =>
                      setAdvanced((a) => ({
                        ...a,
                        [scope]: { anchors: a[scope]?.anchors ?? '', maxTraj: e.target.value, steps: a[scope]?.steps ?? '' }
                      }))
                    }
                  />
                </label>
                <label className="empty">
                  Training steps
                  <input
                    type="text"
                    size={6}
                    placeholder="5001"
                    value={advanced[scope]?.steps ?? ''}
                    onChange={(e) =>
                      setAdvanced((a) => ({
                        ...a,
                        [scope]: { anchors: a[scope]?.anchors ?? '', maxTraj: a[scope]?.maxTraj ?? '', steps: e.target.value }
                      }))
                    }
                  />
                </label>
              </div>
              <p className="empty">
                Anything filled in here overrides the preset. <strong>Max trajectories</strong> is the one that
                costs time — 0 means uncapped. <strong>Training steps</strong> matters when trajectories go up:
                more views spread the same effort thinner, so a bigger world wants more steps to stay sharp.
              </p>
            </details>

            {genStatus && genStatus.state !== 'running' && (
              <p className={genStatus.state === 'error' ? 'error' : 'run-status-ok'}>
                {genStatus.message.slice(0, 400)}
              </p>
            )}
            {worldStatus && worldStatus.state !== 'running' && (
              <p className={worldStatus.state === 'error' ? 'error' : 'run-status-ok'}>
                {worldStatus.message.slice(0, 400)}
              </p>
            )}
          </div>
        )
      })}
    </div>
  )
}
