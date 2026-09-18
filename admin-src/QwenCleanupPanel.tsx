import { useEffect, useState } from 'react'
import { Select } from './ui/Select'
import { IMAGE_ACCEPT } from './storage'
import { insforge, comfyViewUrl, type Movie, type Scene, type QwenCleanup } from './insforge'
import { triggerFlow, type RunStatus } from './flowise'
import { SplatViewer } from './ui/SplatViewer'
import { PanoViewer } from './ui/PanoViewer'
import { ImageSelect } from './ui/ImageSelect'
import { loadImageSources, toPickerGroups, type ImageSource } from './imageSources'
import { saveSnapshotToProject } from './frames'
import { deleteAssetFiles, keptNote } from './assets'


// The prompt 6-GS-Cleaner hardcodes. Exposed here so a standalone run can be
// steered, but defaulted to the proven wording so it behaves identically to the
// pipeline step unless deliberately changed.
const DEFAULT_PROMPT =
  'Using Gaussian Splatting, refer to the scene graph in Figure 2 to fix the perspective of the scene graph in Figure 1 and fill in the blank areas.'


export function QwenCleanupPanel({ movie }: { movie: Movie }) {
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)
  const [busyDelete, setBusyDelete] = useState<string | null>(null)
  const [jobs, setJobs] = useState<QwenCleanup[]>([])
  const [scenes, setScenes] = useState<Scene[]>([])
  const [sceneKey, setSceneKey] = useState('')
  const [refSource, setRefSource] = useState<'scene' | 'upload'>('scene')
  const [sourceFile, setSourceFile] = useState<File | null>(null)
  const [referenceFile, setReferenceFile] = useState<File | null>(null)
  const [prompt, setPrompt] = useState(DEFAULT_PROMPT)
  const [status, setStatus] = useState<RunStatus | null>(null)
  const [error, setError] = useState<string | null>(null)
  // Viewers feed the two slots directly: a splat snapshot is the source to be
  // corrected, a panorama snapshot is the clean reference to correct it against.
  const [viewer, setViewer] = useState<'splat' | 'pano' | null>(null)
  const [splats, setSplats] = useState<{ act_number: number; scene_number: number; ply_path: string }[]>([])
  const [panos, setPanos] = useState<{ act_number: number; scene_number: number; image_path: string }[]>([])
  const [sourcePreview, setSourcePreview] = useState<string | null>(null)
  const [referencePreview, setReferencePreview] = useState<string | null>(null)
  // Pictures already in this movie. Picking one fetches it from ComfyUI into the
  // same File slot an upload fills, so the run path is unchanged.
  const [sources, setSources] = useState<ImageSource[]>([])
  const [sourcePick, setSourcePick] = useState('')
  const [refPick, setRefPick] = useState('')

  async function pickFromMovie(id: string, slot: 'source' | 'reference') {
    const src = sources.find((s) => s.id === id)
    if (!src) return
    ;(slot === 'source' ? setSourcePick : setRefPick)(id)
    setError(null)
    try {
      const url = comfyViewUrl(src.path)
      const res = await fetch(url)
      if (!res.ok) throw new Error(`Could not read ${src.label} (HTTP ${res.status})`)
      const blob = await res.blob()
      const name = src.path.split(/[\\/]/).pop() || 'picked.png'
      const file = new File([blob], name, { type: blob.type || 'image/png' })
      if (slot === 'source') {
        setSourceFile(file)
        setSourcePreview(url)
      } else {
        setReferenceFile(file)
        setReferencePreview(url)
        setRefSource('upload')
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  const scene = scenes.find((s) => `${s.act_number}-${s.scene_number}` === sceneKey)
  const key = (x: { act_number: number; scene_number: number }) => `${x.act_number}-${x.scene_number}`
  // Prefer the splat and panorama for the scene already selected; otherwise the
  // first available, so the viewers are usable before a scene is chosen.
  const activeSplat = splats.find((x) => key(x) === sceneKey) ?? splats[0]
  const activePano = panos.find((x) => key(x) === sceneKey) ?? panos[0]

  // Confirm before removing, since the cleaned image is often the only copy -
  // the source was a viewer snapshot that lives nowhere else.
  async function handleDeleteJob(job: QwenCleanup) {
    setBusyDelete(job.id)
    const { error: delError } = await insforge.database.from('qwen_cleanups').delete().eq('id', job.id)
    if (delError) setError(delError.message)
    else {
      const r = await deleteAssetFiles([job.cleaned_image_path])
      const note = keptNote(r)
      if (note) setError(note)
      await loadJobs()
    }
    setBusyDelete(null)
    setConfirmDelete(null)
  }

  async function loadJobs() {
    const { data, error: loadError } = await insforge.database
      .from('qwen_cleanups')
      .select('*')
      .eq('movie_id', movie.id)
      .order('created_at', { ascending: false })
    if (loadError) setError(loadError.message)
    else setJobs((data ?? []) as QwenCleanup[])
  }

  useEffect(() => {
    async function loadViewerSources() {
      const { data: sp } = await insforge.database
        .from('scene_splats')
        .select('act_number,scene_number,ply_path')
        .eq('movie_id', movie.id)
        .order('act_number', { ascending: true })
      setSplats(((sp ?? []) as typeof splats).filter((x) => x.ply_path))
      const { data: pn } = await insforge.database
        .from('scene_panos')
        .select('act_number,scene_number,image_path')
        .eq('movie_id', movie.id)
        .order('act_number', { ascending: true })
      setPanos(((pn ?? []) as typeof panos).filter((x) => x.image_path))
    }
    loadViewerSources()

    async function loadScenes() {
      const { data, error: sceneError } = await insforge.database
        .from('scenes')
        .select('*')
        .eq('movie_id', movie.id)
        .order('act_number', { ascending: true })
        .order('scene_number', { ascending: true })
      if (sceneError) setError(sceneError.message)
      else {
        const rows = (data ?? []) as Scene[]
        setScenes(rows)
        setSceneKey(rows[0] ? `${rows[0].act_number}-${rows[0].scene_number}` : '')
      }
    }
    loadScenes()
    loadJobs()
    loadImageSources(movie.id).then(setSources)
    setSourcePick('')
    setRefPick('')
    setStatus(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [movie.id])

  async function uploadImage(file: File, suffix: string): Promise<string | null> {
    const key = `qwen-cleanup/${Date.now()}-${suffix}-${file.name}`
    const { data, error: uploadError } = await insforge.storage.from(movie.bucket_name).upload(key, file)
    if (uploadError || !data) {
      setError(uploadError?.message ?? `Upload of the ${suffix} image failed`)
      return null
    }
    return data.key
  }

  async function handleRun() {
    if (!sourceFile) return
    setError(null)
    setStatus({ state: 'running', message: '' })

    const sourceKey = await uploadImage(sourceFile, 'source')
    if (!sourceKey) {
      setStatus({ state: 'error', message: 'Source image upload failed.' })
      return
    }

    let referenceKey: string | null = null
    if (refSource === 'upload') {
      if (!referenceFile) {
        setStatus({ state: 'error', message: 'Pick a reference image, or switch to using a scene panorama.' })
        return
      }
      referenceKey = await uploadImage(referenceFile, 'reference')
      if (!referenceKey) {
        setStatus({ state: 'error', message: 'Reference image upload failed.' })
        return
      }
    } else if (!scene) {
      setStatus({ state: 'error', message: 'Pick a scene whose panorama should be used as the reference.' })
      return
    }

    const { data: inserted, error: insertError } = await insforge.database
      .from('qwen_cleanups')
      .insert([
        {
          movie_id: movie.id,
          act_number: refSource === 'scene' && scene ? scene.act_number : null,
          scene_number: refSource === 'scene' && scene ? scene.scene_number : null,
          source_image_path: sourceKey,
          reference_image_path: referenceKey,
          prompt,
          status: 'queued'
        }
      ])
      .select()

    if (insertError) {
      setStatus({ state: 'error', message: insertError.message })
      return
    }
    // Same readback fallback as the MiniMax panels: the SDK does not reliably
    // echo the inserted row.
    let job = (inserted ?? [])[0] as QwenCleanup | undefined
    if (!job) {
      const { data: recent } = await insforge.database
        .from('qwen_cleanups')
        .select('*')
        .eq('movie_id', movie.id)
        .order('created_at', { ascending: false })
        .limit(1)
      job = ((recent ?? []) as QwenCleanup[])[0]
    }
    if (!job) {
      setStatus({ state: 'error', message: 'Cleanup row could not be read back after insert.' })
      return
    }

    await loadJobs()
    setStatus({
      state: 'done',
      message: 'Submitted - Qwen cleanup takes a couple of minutes. Click Refresh to check; it continues on the server even if you navigate away.'
    })
    triggerFlow(import.meta.env.VITE_QWEN_CLEANUP_ID, { cleanupId: job.id }).then((result) => {
      setStatus(result)
      loadJobs()
    })
  }

  return (
    <div>
    {viewer === 'splat' && activeSplat && (
      <SplatViewer
        plyPath={activeSplat.ply_path}
        label={`Splat — A${activeSplat.act_number}S${activeSplat.scene_number}`}
        // Turn the splat upright from its own up_direction, exactly as the
        // HY-World tab does. Without this the viewer loads the raw .ply: world
        // generation picks an up axis per scene (this study came out +Z up) and
        // the viewer treats file -Z as screen-up, so the room arrives upside
        // down. The world builder deliberately writes no _yup copy - a fixed
        // flip capsized as many splats as it righted - so the per-scene
        // rotation here is the only thing that rights them.
        orient="scene-up"
        onClose={() => setViewer(null)}
        onSnapshot={(file, preview) => {
          // Straight into the source slot: this IS the angle to be corrected.
          setSourceFile(file)
          setSourcePreview(preview)
          setSourcePick('')
          setViewer(null)
          // And kept, so the same angle can be picked anywhere in the movie.
          saveSnapshotToProject(movie, file, {
            kind: 'splat',
            label: `A${activeSplat.act_number}S${activeSplat.scene_number} splat`
          }).then((r) => {
            if ('error' in r) setError(`Snapshot not saved to the movie: ${r.error}`)
            else loadImageSources(movie.id).then(setSources)
          })
        }}
      />
    )}

    {viewer === 'pano' && activePano && (
      <PanoViewer
        src={comfyViewUrl(activePano.image_path)}
        label={`Panorama — A${activePano.act_number}S${activePano.scene_number}`}
        onClose={() => setViewer(null)}
        onSnapshot={(file, preview) => {
          // The clean plate to correct against. Switching to "upload my own" so the
          // captured frame is used rather than the whole equirectangular panorama.
          setReferenceFile(file)
          setReferencePreview(preview)
          setRefSource('upload')
          setRefPick('')
          setViewer(null)
          // And kept as a Panorama Snapshot, so it can be picked again here or anywhere.
          saveSnapshotToProject(movie, file, {
            kind: 'pano',
            label: `A${activePano.act_number}S${activePano.scene_number} panorama`
          }).then((r) => {
            if ('error' in r) setError(`Snapshot not saved to the movie: ${r.error}`)
            else loadImageSources(movie.id).then(setSources)
          })
        }}
      />
    )}

      {error && <p className="error">{error}</p>}
      <h3>Qwen Cleanup</h3>
      <p className="empty">
        Two-image edit: the source (Figure 1) is corrected against a clean reference (Figure 2). This is the same graph
        the Ref to Video tab runs as its cleanup step, available on its own for any image.
      </p>

      <h4>Source image (Figure 1)</h4>
      <p className="empty">
        The angle that needs correcting. Capture it from the scene's gaussian splat, pick one from this movie, or
        upload one.
      </p>
      <div className="upload-form">
        <label>
          Pick from this movie
          <ImageSelect
            value={sourcePick}
            groups={toPickerGroups(sources)}
            placeholder={sources.length ? 'Pick a picture…' : 'No pictures in this movie yet'}
            onValueChange={(id) => pickFromMovie(id, 'source')}
          />
        </label>
        <input
          type="file"
          accept={IMAGE_ACCEPT}
          onChange={(e) => {
            setSourceFile(e.target.files?.[0] ?? null)
            setSourcePreview(null)
            setSourcePick('')
          }}
        />
        <button
          type="button"
          disabled={!activeSplat}
          title={activeSplat ? `A${activeSplat.act_number}S${activeSplat.scene_number}` : 'No splat built for this movie yet'}
          onClick={() => setViewer('splat')}
        >
          Capture from splat
        </button>
      </div>
      {sourcePreview && (
        <p className="empty">
          {sourcePick ? 'Picked from this movie:' : 'Captured from the splat:'}{' '}
          <img className="capture-preview" src={sourcePreview} alt="source" />
        </p>
      )}

      <h4>Reference (Figure 2)</h4>
      <div className="upload-form">
        <label>
          <input
            type="radio"
            name="ref-source"
            checked={refSource === 'scene'}
            onChange={() => setRefSource('scene')}
          />{' '}
          Use a scene panorama
        </label>
        <label>
          <input
            type="radio"
            name="ref-source"
            checked={refSource === 'upload'}
            onChange={() => setRefSource('upload')}
          />{' '}
          Upload my own
        </label>
      </div>
      <div className="upload-form">
          <button
            type="button"
            disabled={!activePano}
            title={activePano ? `A${activePano.act_number}S${activePano.scene_number}` : "No panorama for this movie yet"}
            onClick={() => setViewer("pano")}
          >
            Capture from panorama
          </button>
          <label>
            Panorama snapshot
            <ImageSelect
              value={refPick}
              groups={toPickerGroups(sources).filter((g) => g.label === 'Panorama Snapshots')}
              placeholder={
                sources.some((s) => s.group === 'Panorama Snapshots') ? 'Pick a snapshot…' : 'No panorama snapshots yet'
              }
              onValueChange={(id) => pickFromMovie(id, 'reference')}
            />
          </label>
          {referencePreview && (
            <img className="capture-preview" src={referencePreview} alt="captured reference" />
          )}
      </div>
      {refSource === 'scene' ? (
        <div className="upload-form">
          <Select
            value={sceneKey}
            onValueChange={setSceneKey}
            placeholder={scenes.length === 0 ? 'No scenes yet' : 'Scene'}
            items={scenes.map((s) => ({
              value: `${s.act_number}-${s.scene_number}`,
              label: `A${s.act_number}S${s.scene_number} — ${s.location_name ?? '(no location)'}`
            }))}
          />
        </div>
      ) : (
        <div className="upload-form">
          <label>
            Pick from this movie
            <ImageSelect
              value={refPick}
              groups={toPickerGroups(sources)}
              placeholder={sources.length ? 'Pick a picture…' : 'No pictures in this movie yet'}
              onValueChange={(id) => pickFromMovie(id, 'reference')}
            />
          </label>
          <input
            type="file"
            accept={IMAGE_ACCEPT}
            onChange={(e) => {
              setReferenceFile(e.target.files?.[0] ?? null)
              setReferencePreview(null)
              setRefPick('')
            }}
          />
        </div>
      )}

      <h4>Prompt</h4>
      <textarea className="prompt-editor" rows={4} value={prompt} onChange={(e) => setPrompt(e.target.value)} />
      <button type="button" onClick={() => setPrompt(DEFAULT_PROMPT)}>
        Reset to pipeline default
      </button>

      <h4>Run</h4>
      <button type="button" disabled={status?.state === 'running' || !sourceFile} onClick={handleRun}>
        {status?.state === 'running' ? 'Submitting…' : 'Run Qwen Cleanup'}
      </button>
      <button type="button" onClick={loadJobs}>
        Refresh
      </button>
      {status && status.state !== 'running' && (
        <p className={status.state === 'error' ? 'error' : 'run-status-ok'}>{status.message}</p>
      )}

      <h4>Cleanups</h4>
      {jobs.length === 0 && <p className="empty">Nothing cleaned yet for {movie.title}.</p>}
      {jobs.map((job) => (
        <div className="beat-card" key={job.id}>
          <p>
            {new Date(job.created_at).toLocaleString()} — <span className="badge">{job.status}</span>
            {job.act_number != null && job.scene_number != null && (
              <>
                {' '}
                <span className="badge">
                  A{job.act_number}S{job.scene_number} pano
                </span>
              </>
            )}
            {job.reference_image_path && <span className="badge"> uploaded reference</span>}
            {job.error_message && <span className="error"> — {job.error_message}</span>}
          </p>
          {job.cleaned_image_path && (
            <img className="shot-preview" src={comfyViewUrl(job.cleaned_image_path)} alt="cleaned result" />
          )}
          <div className="edit-ref-actions">
            {confirmDelete === job.id ? (
              <>
                <span className="empty">Delete this cleanup and its image?</span>
                <button
                  type="button"
                  className="danger"
                  disabled={busyDelete !== null}
                  onClick={() => handleDeleteJob(job)}
                >
                  {busyDelete === job.id ? 'Deleting…' : 'Delete'}
                </button>
                <button type="button" onClick={() => setConfirmDelete(null)}>
                  Cancel
                </button>
              </>
            ) : (
              <button type="button" className="danger" onClick={() => setConfirmDelete(job.id)}>
                Delete
              </button>
            )}
          </div>
        </div>
      ))}
    </div>
  )
}
