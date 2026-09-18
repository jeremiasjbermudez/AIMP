import { useEffect, useRef, useState } from 'react'
import { Select } from './ui/Select'
import {
  insforge,
  comfyViewUrl,
  type Movie,
  type Scene,
  type Beat,
  type MinimaxClip,
  type MinimaxClipMode,
  type MovieReferenceImage
} from './insforge'
import { triggerFlow, parseFlowJson, type RunStatus } from './flowise'
import { uploadToMovie, IMAGE_ACCEPT } from './storage'
import { secondsToFrames, suggestFramesForBeat, framesToSeconds, MAX_FRAMES, MIN_FRAMES } from './timing'
import { dialogueLines, speakerRoster } from './dialogue'
import { ImageSelect, type ImageGroup } from './ui/ImageSelect'
import { deleteAssetFiles, deleteStorageObjects, keptNote } from './assets'
import { FramePicker } from './ui/FramePicker'
import { saveFrameToProject } from './frames'
import { dedupeByPath } from './imageSources'
import { loadMovieFrames, frameLabel, frameGroup } from './frames'
import { GradeControl } from './ui/GradeControl'
import { ClipThumbPicker } from './ui/ClipThumbPicker'
import {
  loadCameraPresets,
  cameraInstruction,
  stripCameraLine,

  CAMERA_AXES,
  type CameraPreset,
  type CameraCategory
} from './camera'

// Both tabs are the same panel: MiniMaxH3ImageToVideo takes first_frame and
// last_frame as OPTIONAL inputs, so text-to-video is simply the same node with
// neither wired. Only the frame inputs and the flow endpoint differ, so the
// kind prop drives both rather than duplicating the panel.
//
// 'ref' is the same panel again for Reference to Video. It renders through a
// different ComfyUI node (MiniMaxH3ReferenceToVideo, which takes up to nine
// identity references instead of timeline frames), but everything around it -
// beat picker, prompt, duration, generations list, extend - is identical, so
// it belongs here rather than in the old bespoke Shots panel.
import { VIDEO_KINDS, type Kind } from './videoKinds'

const RESOLUTIONS = [
  { label: '864 x 480 (16:9)', width: 864, height: 480 },
  { label: '1344 x 768 (16:9, larger)', width: 1344, height: 768 },
  { label: '480 x 864 (9:16 portrait)', width: 480, height: 864 },
  { label: '768 x 768 (1:1)', width: 768, height: 768 }
]

/** Sentinel for the "Custom…" entry in the resolution list. */
const CUSTOM_RES = -1

// The video VAE needs both axes on a multiple of 16; a size off that grid fails
// deep in the graph with an unhelpful shape error. 1920 is a practical ceiling
// rather than a model limit - past roughly 2MP this card runs out of memory.
function snap16(v: number, fallback: number) {
  if (!Number.isFinite(v) || v <= 0) return fallback
  return Math.min(1920, Math.max(256, Math.round(v / 16) * 16))
}

// Same beat-derived body the Shots tab writes (style line, summary, dialogue),
// minus its subject_definitions/retention_analysis block: that block names
// "reference image 1..N", and these two modes send no reference images at all -
// first_frame/last_frame are timeline anchors, not identity references - so
// those lines would be describing images the model was never handed.
function draftClipPrompt(beat: Beat, scene?: Scene): string {
  const spokenLines = dialogueLines(beat)
  const roster = speakerRoster(beat)
  return [
    'summary: ' + beat.summary,
    'detailed_description: style: cinematic, live-action, photorealistic. ' +
      [beat.action_text, beat.summary].filter(Boolean).join(' ') +
      (roster ? `\nSpeakers: ${roster}.` : '') +
      (spokenLines.length > 0 ? '\n' + spokenLines.join('\n') : ''),
    // The scene's own ambience, so each clip sits in the room it is actually
    // in - rain, machinery, distant traffic - rather than near silence. This is
    // diegetic sound only.
    'overall_soundscape: ' + (scene?.sound_ambience?.trim() || 'N/A'),
    // Deliberately never a score. MiniMax writes each clip's audio
    // independently, so music baked in here changes key and tempo at every cut.
    // Music is generated once for a whole scene on the Score tab instead.
    'non_diegetic_music: N/A'
  ].join('\n\n')
}

// Ollama takes images as bare base64, so the selected frame is read straight
// from the File rather than round-tripping through storage first.
function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result).replace(/^data:[^;]+;base64,/, ''))
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(file)
  })
}

export function MinimaxVideoPanel({ movie, kind }: { movie: Movie; kind: Kind }) {
  const [clips, setClips] = useState<MinimaxClip[]>([])
  const [scenes, setScenes] = useState<Scene[]>([])
  const [sceneKey, setSceneKey] = useState('')
  const [beats, setBeats] = useState<Beat[]>([])
  const [beatId, setBeatId] = useState('')
  const [prompt, setPrompt] = useState('')
  const [imageMode, setImageMode] = useState<'first' | 'first_last'>('first')
  const [firstFile, setFirstFile] = useState<File | null>(null)
  const [lastFile, setLastFile] = useState<File | null>(null)
  // A frame chosen from the movie sets state the native file input cannot show
  // - it keeps saying "No file chosen" - so picking one looked like it had
  // failed. These previews are the only feedback that it worked.
  const [framePreview, setFramePreview] = useState<{ first?: string; last?: string }>({})
  const [resIndex, setResIndex] = useState(0)
  // Held as strings so the fields can be cleared while typing.
  const [customW, setCustomW] = useState('1024')
  const [customH, setCustomH] = useState('576')
  // Spectrum forecasts some of the model's work instead of computing it.
  // Faster, but approximate - so it is opt-in per render, not a default.
  const [useSpectrum, setUseSpectrum] = useState(false)
  const [durationSeconds, setDurationSeconds] = useState(5)
  const [motionRequest, setMotionRequest] = useState('')
  const [cameraPresets, setCameraPresets] = useState<CameraPreset[]>([])
  const [camera, setCamera] = useState<Partial<Record<CameraCategory, string>>>({})
  // The clip being transformed, on the kinds that transform one.
  const [sourceClipId, setSourceClipId] = useState('')
  // Control to Video: the depth / pose / edge video, how many frames it has
  // (probed on pick, so the shot is never longer than it), its weight, and
  // what pass it is - a label kept with the clip, since the one checkpoint
  // reads every kind and nothing here has to switch on it.
  const [controlFile, setControlFile] = useState<File | null>(null)
  const [controlFrames, setControlFrames] = useState<number | null>(null)
  const [controlStrength, setControlStrength] = useState(0.7)
  const [controlType, setControlType] = useState<'depth' | 'pose' | 'canny' | 'hed' | 'mlsd'>('depth')
  const [sourceClips, setSourceClips] = useState<MinimaxClip[]>([])
  // The system prompt handed to the LLM that rewrites the prompt.
  //
  // It used to live on the Flowise node, one copy for every tab and every
  // film, editable only by opening the flow. It is an instruction about how
  // to treat a clip, so it belongs where the clip is made.
  //
  // Remembered PER TAB, not per movie: what to do with an image-to-video
  // clip is a standing way of working, and having it vanish on every movie
  // switch would mean pasting it again all day. Blank means the flow’s own
  // system prompt is used, exactly as before.
  const SYSTEM_KEY = `minimax.systemPrompt.${kind}`
  const [systemPrompt, setSystemPromptRaw] = useState(() => {
    try {
      return localStorage.getItem(`minimax.systemPrompt.${kind}`) ?? ''
    } catch (e) {
      // Private windows and blocked site data both throw here.
      return ''
    }
  })
  function setSystemPrompt(next: string) {
    setSystemPromptRaw(next)
    try {
      if (next) localStorage.setItem(SYSTEM_KEY, next)
      else localStorage.removeItem(SYSTEM_KEY)
    } catch (e) {
      /* not remembering it is a smaller problem than refusing to set it */
    }
  }
  const [enhanceStatus, setEnhanceStatus] = useState<RunStatus | null>(null)
  const [extending, setExtending] = useState<string | null>(null)
  // Which clip's frame picker is open, and where its handle sits.
  const [pickFor, setPickFor] = useState<string | null>(null)
  const [pickFrame, setPickFrame] = useState(0)
  const [grabbed, setGrabbed] = useState<string | null>(null)
  // Reference to Video only: the pickable images, and what is picked. Order
  // matters - the first entry becomes the model's Picture 1.
  const [refPool, setRefPool] = useState<MovieReferenceImage[]>([])
  const [picked, setPicked] = useState<string[]>([])
  const [addingRef, setAddingRef] = useState(false)
  // The same picker Image Edit uses. Choosing one copies it into the reference
  // pool, because the pool is storage-backed while these live in ComfyUI.
  const [catalogue, setCatalogue] = useState<{ id: string; path: string; label: string; group: string }[]>([])
  const [poolPreviews, setPoolPreviews] = useState<Record<string, string>>({})
  const [poolFailed, setPoolFailed] = useState<Record<string, string>>({})
  const fetchedKeys = useRef<Set<string>>(new Set())
  const madeUrls = useRef<string[]>([])
  const [lightbox, setLightbox] = useState<{ src: string; label: string } | null>(null)
  const [status, setStatus] = useState<RunStatus | null>(null)
  const [error, setError] = useState<string | null>(null)
  // Deleting a clip is confirmed in place, and the confirmation names what
  // else goes with it - a clip can have extensions built on top of it and a
  // post-voice version hanging off it, neither of which is visible here.
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)
  const [deleteImpact, setDeleteImpact] = useState<{ extensions: number; revoiced: number } | null>(null)
  const [deletingClip, setDeletingClip] = useState<string | null>(null)

  const cfg = VIDEO_KINDS[kind]
  const flowId = cfg.flowId
  const customSize = { width: snap16(Number(customW), 864), height: snap16(Number(customH), 480) }
  const resolution = resIndex === CUSTOM_RES ? customSize : RESOLUTIONS[resIndex]
  const length = secondsToFrames(durationSeconds)
  // A greyed-out button with no explanation is the worst of both worlds.
  const REF_GROUP_ORDER = ['Characters', 'World', 'Cleaned plates', 'Face fixes', 'Splat Snapshots', 'Panorama Snapshots', 'Cleanups', 'Edits', 'Frames']
  const refPickerGroups: ImageGroup[] = REF_GROUP_ORDER.map((g) => ({
    label: g,
    items: catalogue.filter((c) => c.group === g).map((c) => ({ value: c.id, label: c.label, thumb: comfyViewUrl(c.path) }))
  })).filter((g) => g.items.length > 0)

  // Match the source's shape and length when a clip is picked to transform.
  //
  // Rendering a 768x768 source at the last-used 864x480 does not letterbox it -
  // the model recomposes the shot to fit, which reads as an unasked-for reframe
  // on top of the restyle. Following the source is what "keep the performance"
  // implies, and it is still overridable afterwards.
  useEffect(() => {
    if (!cfg.usesSourceClip || !sourceClipId) return
    const src = sourceClips.find((c) => c.id === sourceClipId)
    if (!src) return
    const idx = RESOLUTIONS.findIndex((r) => r.width === src.width && r.height === src.height)
    if (idx >= 0) setResIndex(idx)
    else {
      setResIndex(CUSTOM_RES)
      setCustomW(String(src.width))
      setCustomH(String(src.height))
    }
    setDurationSeconds(Math.max(1, Math.round(src.length / 24)))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceClipId])

  const blockedReason = cfg.requires({
    prompt,
    hasFirstImage: !!firstFile,
    refCount: picked.length,
    hasSourceClip: !!sourceClipId,
    hasControlVideo: !!controlFile
  })

  /** H3 lengths are 5 mod 17 frames in 124..362; the largest one at most n. */
  function controlLengthAtMost(n: number): number {
    const down = n - ((((n - 5) % 17) + 17) % 17)
    return Math.min(362, Math.max(124, down))
  }

  /**
   * Pick the control video. Its duration is read in the browser so the shot
   * length can be set to what the video covers: the ControlNet needs a
   * control frame for every generated frame, and a video shorter than the
   * shot fails inside the graph.
   */
  function pickControlVideo(file: File | null) {
    setControlFile(file)
    setControlFrames(null)
    if (!file) return
    const url = URL.createObjectURL(file)
    const probe = document.createElement('video')
    probe.preload = 'metadata'
    probe.onloadedmetadata = () => {
      const frames = Math.floor(probe.duration * 24)
      setControlFrames(frames)
      setDurationSeconds(Math.max(1, Math.floor(controlLengthAtMost(frames) / 24)))
      URL.revokeObjectURL(url)
    }
    probe.onerror = () => {
      setError('That file could not be read as a video.')
      URL.revokeObjectURL(url)
    }
    probe.src = url
  }

  useEffect(() => {
    if (!cfg.usesSourceClip) return
    insforge.database
      .from('minimax_clips')
      .select('*')
      .eq('movie_id', movie.id)
      .eq('status', 'complete')
      .neq('mode', 'v2v')
      .order('created_at', { ascending: false })
      .then(({ data }) => setSourceClips((data ?? []) as MinimaxClip[]))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [movie.id, kind])

  useEffect(() => {
    loadCameraPresets(movie.id).then(setCameraPresets)
    setCamera({})
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [movie.id])

  async function loadClips() {
    const modes: MinimaxClipMode[] = cfg.listModes
    const { data, error: loadError } = await insforge.database
      .from('minimax_clips')
      .select('*')
      // Graded copies come back too, then are filtered to this tab's own clips
      // below - a grade made here must be visible here, or the Apply looks
      // like it did nothing.
      .eq('movie_id', movie.id)
      .filter('mode', 'in', `(${[...modes, 'graded'].join(',')})`)
      // Extensions of a Ref to Video shot are shown on that tab instead.
      .is('source_shot_id', null)
      .order('created_at', { ascending: false })
    if (loadError) {
      setError(loadError.message)
      return
    }
    const rows = (data ?? []) as MinimaxClip[]
    const own = new Set(rows.filter((c) => c.mode !== 'graded').map((c) => c.id))
    setClips(
      rows.filter(
        (c) =>
          c.mode !== 'graded' ||
          // A grade whose source was deleted has nowhere else to appear, so it
          // is shown rather than orphaned into invisibility.
          c.source_clip_id === null ||
          own.has(c.source_clip_id)
      )
    )
  }

  useEffect(() => {
    loadClips()
    setStatus(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [movie.id, kind])

  async function loadCatalogue() {
    const out: { id: string; path: string; label: string; group: string }[] = []
    const { data: chars } = await insforge.database
      .from('characters')
      .select('id,name')
      .eq('movie_id', movie.id)
      .order('name', { ascending: true })
    const ids = (chars ?? []).map((c: { id: string }) => c.id)
    if (ids.length) {
      const { data: imgs } = await insforge.database
        .from('character_images')
        .select('id,character_id,kind,version,image_path')
        .filter('character_id', 'in', `(${ids.join(',')})`)
        .order('version', { ascending: false })
      const byId = new Map((chars ?? []).map((c: { id: string; name: string }) => [c.id, c.name]))
      for (const im of imgs ?? []) {
        if (!im.image_path) continue
        out.push({ id: im.id, path: im.image_path, label: `${byId.get(im.character_id) ?? '?'} — ${im.kind} v${im.version}`, group: 'Characters' })
      }
    }
    const { data: panos } = await insforge.database
      .from('scene_panos')
      .select('act_number,scene_number,image_path')
      .eq('movie_id', movie.id)
      .order('act_number', { ascending: true })
    for (const p of panos ?? []) {
      if (!p.image_path) continue
      out.push({ id: `pano-${p.act_number}-${p.scene_number}`, path: p.image_path, label: `A${p.act_number}S${p.scene_number} panorama`, group: 'World' })
    }
    const { data: cleanups } = await insforge.database
      .from('qwen_cleanups')
      .select('id,act_number,scene_number,cleaned_image_path,created_at')
      .eq('movie_id', movie.id)
      .eq('status', 'complete')
      .order('created_at', { ascending: false })
    for (const c of cleanups ?? []) {
      if (!c.cleaned_image_path) continue
      const where = c.act_number != null ? `A${c.act_number}S${c.scene_number}` : 'no scene'
      out.push({ id: `cleanup-${c.id}`, path: c.cleaned_image_path, label: `${where} cleanup`, group: 'Cleanups' })
    }
    const { data: edits } = await insforge.database
      .from('image_edits')
      .select('id,prompt,output_path,created_at,engine')
      .eq('movie_id', movie.id)
      .eq('status', 'complete')
      .order('created_at', { ascending: false })
    for (const e of edits ?? []) {
      if (!e.output_path) continue
      const isFaceFix = e.engine === 'face_fix'
      out.push({
        id: `edit-${e.id}`,
        path: e.output_path,
        label: isFaceFix ? String(e.prompt) : String(e.prompt).slice(0, 44),
        group: isFaceFix ? 'Face fixes' : 'Edits'
      })

    // Frames grabbed out of rendered clips. Listed last because they are the
    // newest thing in a session and read as scratch material.
    for (const f of await loadMovieFrames(movie.id)) {
      out.push({ id: `frame-${f.id}`, path: f.image_path, label: frameLabel(f), group: frameGroup(f) })
    }
    }
    setCatalogue(dedupeByPath(out))
  }

  async function loadPool() {
    const { data } = await insforge.database
      .from('movie_reference_images')
      .select('*')
      .eq('movie_id', movie.id)
      .order('created_at', { ascending: true })
    setRefPool((data ?? []) as MovieReferenceImage[])
  }

  // Character images deliberately do NOT appear here - they live in the
  // Characters tab. Anything you want as a reference is added to the pool
  // below and picked explicitly, so this tab never fills up on its own.
  useEffect(() => {
    // Every kind can pick a frame from the movie, so the catalogue is not
    // limited to the reference tab any more.
    loadCatalogue()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [movie.id])

  useEffect(() => {
    if (!cfg.usesRefPool) return
    async function loadRefSources() {
      await loadPool()
      await loadCatalogue()
    }
    loadRefSources()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [movie.id, kind])

  // These images need an Authorization header, so they cannot be handed to an
  // <img src> directly. createSignedUrl does not help either: this InsForge
  // build answers download-strategy with method "direct" and an UNSIGNED url,
  // so the header is still required. Download through the SDK (which carries
  // the session) and show the bytes as blob URLs instead.
  //
  // Each key is fetched at most ONCE and its blob URL is revoked only when the
  // panel unmounts. Revoking on every re-run (refPool gets a new identity each
  // time the pool reloads) would kill URLs still on screen and re-download
  // megabytes of images to replace them.
  useEffect(() => {
    // Every kind can pick a frame from the movie, so the catalogue is not
    // limited to the reference tab any more.
    loadCatalogue()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [movie.id])

  useEffect(() => {
    if (!cfg.usesRefPool) return
    const pending = refPool.filter((r) => !fetchedKeys.current.has(r.storage_key))
    if (pending.length === 0) return
    let cancelled = false
    ;(async () => {
      for (const ref of pending) {
        if (cancelled) break
        fetchedKeys.current.add(ref.storage_key)
        const { data, error: dlError } = await insforge.storage
          .from(movie.bucket_name)
          .download(ref.storage_key)
        if (cancelled) break
        if (dlError || !data) {
          // Let it be retried rather than sticking on "loading..." forever.
          fetchedKeys.current.delete(ref.storage_key)
          setPoolFailed((prev) => ({ ...prev, [ref.storage_key]: dlError?.message ?? 'could not load' }))
          continue
        }
        const url = URL.createObjectURL(data)
        madeUrls.current.push(url)
        setPoolPreviews((prev) => ({ ...prev, [ref.storage_key]: url }))
      }
    })()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refPool, kind, movie.bucket_name])

  // Blob URLs are only released when the panel goes away.
  useEffect(() => {
    const urls = madeUrls.current
    return () => urls.forEach((u) => URL.revokeObjectURL(u))
  }, [])

  async function handleRemoveFromPool(ref: MovieReferenceImage) {
    setError(null)
    const { error: delError } = await insforge.database
      .from('movie_reference_images')
      .delete()
      .eq('id', ref.id)
    if (delError) {
      setError(delError.message)
      return
    }
    // The upload lives in object storage rather than ComfyUI's folders, so it
    // is removed directly.
    await deleteStorageObjects(movie.bucket_name, [ref.storage_key])
    setPicked((prev) => prev.filter((v) => v !== ref.storage_key))
    setRefPool((prev) => prev.filter((r) => r.id !== ref.id))
  }

  function togglePicked(value: string) {
    setPicked((prev) => (prev.includes(value) ? prev.filter((v) => v !== value) : [...prev, value]))
  }

  // Pull an image out of the movie and use it as a frame. The panel works in
  // File objects because that is what the upload path takes, so a ComfyUI-served
  // image is fetched and wrapped rather than referenced where it sits.
  async function handlePickFrame(id: string, slot: 'first' | 'last') {
    const item = catalogue.find((c) => c.id === id)
    if (!item) return
    setError(null)
    try {
      const res = await fetch(comfyViewUrl(item.path))
      if (!res.ok) throw new Error(`Could not read that image (HTTP ${res.status})`)
      const blob = await res.blob()
      const name = item.path.split('/').pop() || 'frame.png'
      const file = new File([blob], name, { type: blob.type || 'image/png' })
      const url = URL.createObjectURL(file)
      madeUrls.current.push(url)
      if (slot === 'first') {
        setFirstFile(file)
        setFramePreview((p) => ({ ...p, first: url }))
      } else {
        setLastFile(file)
        setFramePreview((p) => ({ ...p, last: url }))
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  async function handleAddFromMovie(id: string) {
    const item = catalogue.find((c) => c.id === id)
    if (!item) return
    setAddingRef(true)
    setError(null)
    try {
      // The pool stores InsForge keys, so a ComfyUI-served image has to be
      // copied in rather than referenced where it sits.
      const res = await fetch(comfyViewUrl(item.path))
      if (!res.ok) throw new Error(`Could not read that image (HTTP ${res.status})`)
      const blob = await res.blob()
      const name = item.path.split(/[\/]/).pop() || 'reference.png'
      const file = new File([blob], name, { type: blob.type || 'image/png' })
      await handleAddToPool(file)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setAddingRef(false)
    }
  }

  async function handleAddToPool(file: File) {
    setAddingRef(true)
    setError(null)
    const up = await uploadToMovie(movie, 'movie-refs', file)
    if ('error' in up) {
      setError(up.error)
      setAddingRef(false)
      return
    }
    const { error: insertError } = await insforge.database
      .from('movie_reference_images')
      .insert([{ movie_id: movie.id, storage_key: up.key, original_filename: file.name }])
    if (insertError) setError(insertError.message)
    // Adding an image is itself a choice: pick it, rather than making the user
    // add it and then discover it has to be clicked as well.
    else setPicked((prev) => [...prev, up.key])
    await loadPool()
    setAddingRef(false)
  }

  // Scene -> beat selection mirrors the Shots tab so the two behave the same.
  useEffect(() => {
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [movie.id])

  const scene = scenes.find((s) => `${s.act_number}-${s.scene_number}` === sceneKey)

  useEffect(() => {
    async function loadBeats() {
      if (!scene) return
      const { data, error: beatError } = await insforge.database
        .from('beats')
        .select('*')
        .eq('movie_id', movie.id)
        .eq('act_number', scene.act_number)
        .eq('scene_number', scene.scene_number)
        .order('beat_number', { ascending: true })
      if (beatError) setError(beatError.message)
      else {
        const rows = (data ?? []) as Beat[]
        setBeats(rows)
        setBeatId(rows[0]?.id ?? '')
      }
    }
    setBeatId('')
    setBeats([])
    loadBeats()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scene?.id])

  const beat = beats.find((b) => b.id === beatId)

  // Duration is derived from the beat's dialogue by default and stays editable:
  // picking a beat re-derives it, typing over it wins until the beat changes.
  useEffect(() => {
    if (!beat) return
    const suggestion = suggestFramesForBeat(beat)
    setDurationSeconds(Number(framesToSeconds(suggestion.frames).toFixed(2)))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [beat?.id])

  const suggestion = beat ? suggestFramesForBeat(beat) : null

  async function uploadFrame(file: File, suffix: string): Promise<string | null> {
    const key = `minimax/${Date.now()}-${suffix}-${file.name}`
    const { data, error: uploadError } = await insforge.storage.from(movie.bucket_name).upload(key, file)
    if (uploadError || !data) {
      setError(uploadError?.message ?? `Upload of the ${suffix} frame failed`)
      return null
    }
    return data.key
  }

  /**
   * Rewrite a prompt under this tab’s system prompt.
   *
   * Shared by Generate and by the Enhance button, so the two cannot drift:
   * what you get when you press Enhance is exactly what a render would have
   * done on its own.
   *
   * Returns the rewritten prompt, or an error to report. It never returns the
   * ORIGINAL on failure - a render that quietly ignored your instructions and
   * spent three minutes of GPU anyway is worse than one that did not start.
   */
  async function applySystemPrompt(
    draft: string
  ): Promise<{ prompt: string; note: string } | { error: string }> {
    let imageBase64 = ''
    if (cfg.usesFirstImage && firstFile) {
      try {
        imageBase64 = await fileToBase64(firstFile)
      } catch {
        return { error: 'Could not read the first image.' }
      }
    }
    const res = parseFlowJson<{
      prompt: string
      motionWords: number
      dialogueLines: number
      retried: boolean
      model: string
      systemFrom: string
    }>(
      await triggerFlow(import.meta.env.VITE_PROMPT_ENHANCER_ID, {
        draft,
        motion: motionRequest,
        imageBase64,
        systemPrompt: systemPrompt.trim()
      })
    )
    if (!res.ok) return { error: res.message }
    if (!res.data.prompt || !res.data.prompt.trim()) return { error: 'The rewrite came back empty.' }
    const kept = res.data.dialogueLines > 0 ? `, ${res.data.dialogueLines} dialogue line(s) kept` : ''
    const retry = res.data.retried ? ' (after a retry)' : ''
    const whose = res.data.systemFrom === 'caller' ? ', your system prompt' : ", the flow's own system prompt"
    return {
      prompt: res.data.prompt,
      note: `${res.data.motionWords} words of motion${kept}${retry}${whose} — ${res.data.model}.`
    }
  }

  async function handleGenerate() {
    if (!prompt.trim()) return
    setError(null)
    setStatus({ state: 'running', message: '' })

    let firstKey: string | null = null
    let lastKey: string | null = null

    if (cfg.usesFirstImage) {
      if (!firstFile) {
        setStatus({ state: 'error', message: 'A first image is required for image-to-video.' })
        return
      }
      firstKey = await uploadFrame(firstFile, 'first')
      if (!firstKey) {
        setStatus({ state: 'error', message: 'First frame upload failed.' })
        return
      }
      if (imageMode === 'first_last') {
        if (!lastFile) {
          setStatus({ state: 'error', message: 'This mode needs a last image as well.' })
          return
        }
        lastKey = await uploadFrame(lastFile, 'last')
        if (!lastKey) {
          setStatus({ state: 'error', message: 'Last frame upload failed.' })
          return
        }
      }
    }

    if (cfg.usesRefPool && !cfg.usesControlVideo && picked.length === 0) {
      setStatus({ state: 'error', message: 'Pick at least one reference image.' })
      return
    }

    let controlKey: string | null = null
    let clipLength = length
    if (cfg.usesControlVideo) {
      if (!controlFile) {
        setStatus({ state: 'error', message: 'A control video is required.' })
        return
      }
      if (controlFrames != null && controlFrames < 124) {
        setStatus({ state: 'error', message: `The control video has ${controlFrames} frames at 24 fps; the shortest shot is 124 (about 5.2 s).` })
        return
      }
      setStatus({ state: 'running', message: 'Uploading the control video…' })
      controlKey = await uploadFrame(controlFile, 'control')
      if (!controlKey) {
        setStatus({ state: 'error', message: 'Control video upload failed.' })
        return
      }
      // Never longer than the control video, and always a length H3 accepts.
      clipLength = controlLengthAtMost(controlFrames != null ? Math.min(length, controlFrames) : length)
    }

    const mode: MinimaxClipMode = cfg.rowMode(imageMode)

    const cameraLine = cameraInstruction(cameraPresets, camera)

    // The system prompt is applied HERE, on the way to the render, rather
    // than only when someone remembers to press Enhance. That is what makes
    // it an instruction for this tab instead of a button with a side effect.
    //
    // Before the row is written, so a rewrite that fails leaves no orphaned
    // queued clip behind, and before the camera line is appended, so the
    // model is not asked to rewrite a camera instruction that was chosen
    // from the dropdowns and is not its business.
    let body = prompt
    if (systemPrompt.trim()) {
      setStatus({ state: 'running', message: 'Applying your system prompt…' })
      const shaped = await applySystemPrompt(prompt)
      if ('error' in shaped) {
        setStatus({
          state: 'error',
          message: `Nothing was rendered: your system prompt could not be applied - ${shaped.error}`
        })
        return
      }
      body = shaped.prompt
      // Put it in the box: what renders should be what you can see, and the
      // next press starts from the text that was actually used.
      setPrompt(body)
      setEnhanceStatus({ state: 'done', message: shaped.note })
    }

    // The row is created first so the flow has something to write status and
    // video_path back to, and so a render that outlives this browser tab is
    // still recorded.
    const { data: inserted, error: insertError } = await insforge.database
      .from('minimax_clips')
      .insert([
        {
          movie_id: movie.id,
          beat_id: beatId || null,
          mode,
          prompt: cameraLine ? `${body}

${cameraLine}` : body,
          camera,
          first_image_path: firstKey,
          last_image_path: lastKey,
          reference_image_paths: cfg.usesRefPool ? picked : [],
          source_clip_id: cfg.usesSourceClip ? sourceClipId : null,
          use_spectrum: cfg.allowSpectrum ? useSpectrum : false,
          width: resolution.width,
          height: resolution.height,
          length: clipLength,
          status: 'queued',
          ...(cfg.usesControlVideo
            ? { control_video_path: controlKey, control_strength: controlStrength, control_type: controlType }
            : {})
        }
      ])
      .select()

    if (insertError) {
      setStatus({ state: 'error', message: insertError.message })
      return
    }
    // The SDK does not reliably echo the inserted row back, so fall back to
    // reading the newest queued clip for this movie rather than depending on it.
    let clip = (inserted ?? [])[0] as MinimaxClip | undefined
    if (!clip) {
      const { data: recent } = await insforge.database
        .from('minimax_clips')
        .select('*')
        .eq('movie_id', movie.id)
        .eq('mode', mode)
        .order('created_at', { ascending: false })
        .limit(1)
      clip = ((recent ?? []) as MinimaxClip[])[0]
    }
    if (!clip) {
      setStatus({ state: 'error', message: 'Clip row could not be read back after insert.' })
      return
    }

    await loadClips()
    setStatus({
      state: 'done',
      message: 'Submitted - MiniMax generation takes several minutes. Click Refresh below to check; the render continues on the server even if you navigate away.'
    })
    // Fire-and-poll, same reasoning as the Shots tab: the flow writes status to
    // the row independently, so blocking the button on the full request would
    // just leave it stuck for the whole render.
    triggerFlow(flowId, { clipId: clip.id }).then((result) => {
      setStatus(result)
      loadClips()
    })
  }

  // Rewrites whatever is in the prompt box into a MiniMax delta prompt: motion,
  // action and speech only. On the I2V tab the chosen first frame goes along
  // with it, so the model can see what it must not re-describe.
  async function handleEnhance() {
    setEnhanceStatus({ state: 'running', message: '' })
    const shaped = await applySystemPrompt(prompt)
    if ('error' in shaped) {
      setEnhanceStatus({ state: 'error', message: shaped.error })
      return
    }
    setPrompt(shaped.prompt)
    setEnhanceStatus({ state: 'done', message: shaped.note })
  }

  // Continue an existing clip. Unlike chaining a last frame into first_frame,
  // this carries the SOUNDTRACK forward too - the flow anchors the previous
  // clip's tail frames and its audio at frame 0, so there is no audible seam.
  /**
   * Save a frame of a rendered clip into the movie's reference pool, so it can
   * be picked in Ref to Video.
   *
   * Captured in the browser rather than by a flow: ComfyUI serves /view with
   * permissive CORS, so the video can be drawn to a canvas untainted and the
   * PNG read straight off it. No GPU, no queue, no round-trip.
   */
  async function handleGrabFrame(clip: MinimaxClip, png: Blob, frame: number) {
    setError(null)
    setGrabbed(null)
    // Label it with the beat it came from, when the clip carries one.
    const label = beats.find((x) => x.id === clip.beat_id)?.beat_code ?? null
    const saved = await saveFrameToProject(movie, png, {
      clipId: clip.id,
      frame,
      label: label ?? undefined
    })
    if ('error' in saved) {
      setError(saved.error)
      return
    }
    setGrabbed(`Saved frame ${frame} to ${saved.image_path} — pickable in Image Edit, the video tabs and the panorama guide.`)
    // The catalogue this tab's own picker reads is rebuilt, so the frame is
    // usable here immediately rather than after a reload.
    loadCatalogue()
  }

  async function handleExtend(source: MinimaxClip, guideEndFrame: number | null) {
    setExtending(source.id)
    setError(null)
    const { data: inserted, error: insertError } = await insforge.database
      .from('minimax_clips')
      .insert([
        {
          movie_id: movie.id,
          beat_id: source.beat_id,
          mode: 'extend',
          source_clip_id: source.id,
          // What should happen NEXT. Falls back to the source's prompt so the
          // continuation at least stays in the same world.
          prompt: prompt.trim() || source.prompt,
          width: source.width,
          height: source.height,
          length,
          // NULL keeps the old behaviour - continue from the source's final
          // frame. A number ends the hand-off window earlier, which is how a
          // character who exits before the end stays recognisable.
          guide_end_frame: guideEndFrame,
          status: 'queued'
        }
      ])
      .select()

    if (insertError) {
      setError(insertError.message)
      setExtending(null)
      return
    }
    let created = (inserted ?? [])[0] as MinimaxClip | undefined
    if (!created) {
      const { data: recent } = await insforge.database
        .from('minimax_clips')
        .select('*')
        .eq('movie_id', movie.id)
        .eq('mode', 'extend')
        .order('created_at', { ascending: false })
        .limit(1)
      created = ((recent ?? []) as MinimaxClip[])[0]
    }
    if (!created) {
      setError('Extension row could not be read back after insert.')
      setExtending(null)
      return
    }

    await loadClips()
    setExtending(null)
    setStatus({
      state: 'done',
      message: 'Extending - this takes several minutes. Click Refresh to check; it continues on the server.'
    })
    triggerFlow(import.meta.env.VITE_MINIMAX_EXTEND_ID, { clipId: created.id }).then((result) => {
      setStatus(result)
      loadClips()
    })
  }

  const heading = cfg.heading

  async function askDeleteClip(clip: MinimaxClip) {
    setConfirmDelete(clip.id)
    setDeleteImpact(null)
    // Counted against the database rather than the `clips` array: that array is
    // filtered by mode and source_shot_id, so an extension made on another tab
    // would not appear in it and the warning would undercount.
    const { data: exts } = await insforge.database
      .from('minimax_clips')
      .select('id')
      .eq('source_clip_id', clip.id)
    const { data: revoiced } = await insforge.database
      .from('voice_replacements')
      .select('id')
      .eq('clip_id', clip.id)
    setDeleteImpact({ extensions: (exts ?? []).length, revoiced: (revoiced ?? []).length })
  }

  async function handleDeleteClip(clip: MinimaxClip) {
    setDeletingClip(clip.id)
    setError(null)
    // Row first, then the .mp4. The delete flow keeps any file another row
    // still points at - an extended clip's source, for instance.
    const { error: delError } = await insforge.database.from('minimax_clips').delete().eq('id', clip.id)
    if (delError) setError(delError.message)
    else {
      const r = await deleteAssetFiles([clip.video_path])
      const note = keptNote(r)
      if (note) setError(note)
    }
    setConfirmDelete(null)
    setDeleteImpact(null)
    setDeletingClip(null)
    await loadClips()
  }

  return (
    <div>
      {lightbox && (
        <div className="lightbox" onClick={() => setLightbox(null)}>
          <div className="lightbox-inner" onClick={(e) => e.stopPropagation()}>
            <img src={lightbox.src} alt={lightbox.label} />
            <div className="lightbox-bar">
              <span>{lightbox.label}</span>
              <button type="button" onClick={() => setLightbox(null)}>
                Close
              </button>
            </div>
          </div>
        </div>
      )}
      {error && <p className="error">{error}</p>}
      <h3>{heading}</h3>

      {cfg.usesFirstImage && (
        <>
          <h4>Frames</h4>
          <div className="upload-form">
            <label>
              <input
                type="radio"
                name="image-mode"
                checked={imageMode === 'first'}
                onChange={() => setImageMode('first')}
              />{' '}
              First image only
            </label>
            <label>
              <input
                type="radio"
                name="image-mode"
                checked={imageMode === 'first_last'}
                onChange={() => setImageMode('first_last')}
              />{' '}
              First and last image
            </label>
          </div>
          <p className="empty">
            {imageMode === 'first'
              ? 'The clip animates forward from the first image.'
              : 'The clip is interpolated between the first and last image.'}
          </p>
          <div className="upload-form">
            <span>First image</span>
            <input type="file" accept={IMAGE_ACCEPT} onChange={(e) => {
                const f = e.target.files?.[0] ?? null
                setFirstFile(f)
                if (f) {
                  const u = URL.createObjectURL(f)
                  madeUrls.current.push(u)
                  setFramePreview((p) => ({ ...p, first: u }))
                } else setFramePreview((p) => ({ ...p, first: undefined }))
              }} />
            <ImageSelect
              value=""
              resetAfterPick
              placeholder="or pick from this movie…"
              groups={refPickerGroups}
              onValueChange={(id) => handlePickFrame(id, 'first')}
            />
              {framePreview.first && (
                <span className="frame-chosen">
                  <img src={framePreview.first} alt="chosen frame" />
                  <span className="empty">{firstFile?.name}</span>
                  <button
                    type="button"
                    className="danger"
                    onClick={() => {
                      setFirstFile(null)
                      setFramePreview((p) => ({ ...p, first: undefined }))
                    }}
                  >
                    Clear
                  </button>
                </span>
              )}
          </div>
          {imageMode === 'first_last' && (
            <div className="upload-form">
              <span>Last image</span>
              <input type="file" accept={IMAGE_ACCEPT} onChange={(e) => {
                  const f = e.target.files?.[0] ?? null
                  setLastFile(f)
                  if (f) {
                    const u = URL.createObjectURL(f)
                    madeUrls.current.push(u)
                    setFramePreview((p) => ({ ...p, last: u }))
                  } else setFramePreview((p) => ({ ...p, last: undefined }))
                }} />
              <ImageSelect
                value=""
                resetAfterPick
                placeholder="or pick from this movie…"
                groups={refPickerGroups}
                onValueChange={(id) => handlePickFrame(id, 'last')}
              />
                {framePreview.last && (
                  <span className="frame-chosen">
                    <img src={framePreview.last} alt="chosen frame" />
                    <span className="empty">{lastFile?.name}</span>
                    <button
                      type="button"
                      className="danger"
                      onClick={() => {
                        setLastFile(null)
                        setFramePreview((p) => ({ ...p, last: undefined }))
                      }}
                    >
                      Clear
                    </button>
                  </span>
                )}
            </div>
          )}
        </>
      )}

      {cfg.usesControlVideo && (
        <>
          <h4>Control video</h4>
          <p className="empty">
            A depth, pose or edge pass, rendered over the scene's splat or mesh in Blender or any 3D
            package. It decides layout and the camera move frame by frame; the prompt and the
            reference images below decide the look and who is in it. Rendered at 24 fps, the shot
            can be as long as this video and no longer.
          </p>
          <div className="upload-form">
            <label className="empty">
              Video
              <input
                type="file"
                accept="video/mp4,video/quicktime,video/webm,video/x-msvideo,.mp4,.mov,.webm,.avi"
                onChange={(e) => pickControlVideo(e.target.files?.[0] ?? null)}
              />
            </label>
            <label className="empty">
              Pass
              <Select
                value={controlType}
                onValueChange={(v) => setControlType(v as typeof controlType)}
                items={[
                  { value: 'depth', label: 'Depth' },
                  { value: 'pose', label: 'Pose (skeleton)' },
                  { value: 'canny', label: 'Canny edges' },
                  { value: 'hed', label: 'HED soft edges' },
                  { value: 'mlsd', label: 'MLSD lines' }
                ]}
              />
            </label>
            <label className="empty">
              Strength {controlStrength.toFixed(2)}
              <input
                type="range"
                min={0}
                max={1.5}
                step={0.05}
                value={controlStrength}
                onChange={(e) => setControlStrength(Number(e.target.value))}
              />
            </label>
          </div>
          {controlFile && (
            <p className="empty">
              {controlFile.name}
              {controlFrames != null ? ` · ${controlFrames} frames at 24 fps · shot up to ${controlLengthAtMost(controlFrames)} frames` : ' · reading…'}
            </p>
          )}
          <p className="empty">
            Strength is a budget: near 1.0 follows the pass closely, lower lets the model reinterpret.
            Depth holds the room; pose holds a figure. Above 1.0 washes out.
          </p>
        </>
      )}
      {cfg.usesSourceClip && (
        <>
          <h4>Clip to transform</h4>
          <p className="empty">
            Its performance is kept — the movement, the timing, the acting. The reference images
            below decide what changes: key art transfers a look, a character reference recasts who
            is in it.
          </p>
          <ClipThumbPicker
            value={sourceClipId}
            onValueChange={setSourceClipId}
            clips={sourceClips.map((c) => ({
              id: c.id,
              video_path: c.video_path,
              label: `${c.mode} · ${c.length} frames`,
              sub: new Date(c.created_at).toLocaleString()
            }))}
            empty="No finished clips to transform yet."
          />
        </>
      )}
      {cfg.usesRefPool && (
        <>
          <h4>Reference images</h4>
          <p className="empty">
            <strong>Click an image to use it.</strong> The order you click is the order the model sees them — first
            click becomes Picture 1, then Picture 2, up to nine. Anything you add is picked automatically; click again
            to drop it. Character images live in the Characters tab - add the ones you want here.
          </p>

          <div className="ref-group">
            <strong>Added images</strong>
            <div className="ref-thumbs">
              {refPool.length === 0 && <p className="empty">None added yet.</p>}
              {refPool.map((ref) => {
                const order = picked.indexOf(ref.storage_key)
                return (
                  <button
                    key={ref.id}
                    type="button"
                    className={order >= 0 ? 'ref-thumb selected' : 'ref-thumb'}
                    onClick={() => togglePicked(ref.storage_key)}
                    title={ref.original_filename ?? ref.storage_key}
                  >
                    {poolPreviews[ref.storage_key] ? (
                      <img src={poolPreviews[ref.storage_key]} alt={ref.original_filename ?? 'reference'} />
                    ) : (
                      <span className="ref-loading">
                        {poolFailed[ref.storage_key] ? 'failed to load' : 'loading…'}
                      </span>
                    )}
                    <span className="ref-badge">{order >= 0 ? order + 1 : ''}</span>
                    <span className="ref-caption">{ref.original_filename ?? 'image'}</span>
                    {poolPreviews[ref.storage_key] && (
                      <span
                        className="ref-zoom"
                        title="View full size"
                        onClick={(e) => {
                          e.stopPropagation()
                          setLightbox({
                            src: poolPreviews[ref.storage_key],
                            label: ref.original_filename ?? 'reference'
                          })
                        }}
                      >
                        ⤢
                      </span>
                    )}
                    <span
                      className="ref-remove"
                      title="Remove from the list"
                      onClick={(e) => {
                        e.stopPropagation()
                        handleRemoveFromPool(ref)
                      }}
                    >
                      ✕
                    </span>
                  </button>
                )
              })}
            </div>
          </div>
          <div className="upload-form">
            <input
              type="file"
              accept={IMAGE_ACCEPT}
              disabled={addingRef}
              onChange={(e) => {
                const f = e.target.files?.[0]
                if (f) handleAddToPool(f)
                e.target.value = ''
              }}
            />
            <span className="empty">{addingRef ? 'Uploading…' : 'Add an image to pick from'}</span>
            <ImageSelect
              value=""
              resetAfterPick
              disabled={addingRef}
              placeholder="Add from this movie…"
              groups={refPickerGroups}
              onValueChange={handleAddFromMovie}
            />
          </div>
          <p className={picked.length > 0 ? 'run-status-ok' : 'empty'}>
            {picked.length === 0
              ? 'Nothing picked yet — at least one image is needed.'
              : `${picked.length} picked, in this order.`}
            {picked.length > 9 && ' Only the first nine are used.'}
          </p>
        </>
      )}

      <h4>Beat</h4>
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
        <Select
          value={beatId}
          onValueChange={setBeatId}
          placeholder={beats.length === 0 ? 'No beats for this scene' : 'Beat'}
          items={beats.map((b) => ({ value: b.id, label: b.beat_code ?? `beat ${b.beat_number}` }))}
        />
      </div>
      {beat && <p className="beat-summary">{beat.summary}</p>}

      <h4>Prompt</h4>
      <div className="upload-form">
        <button type="button" disabled={!beat} onClick={() => beat && setPrompt(draftClipPrompt(beat, scene))}>
          Fill from beat
        </button>
        <button
          type="button"
          disabled={enhanceStatus?.state === 'running' || (!prompt.trim() && !motionRequest.trim())}
          onClick={handleEnhance}
        >
          {enhanceStatus?.state === 'running' ? 'Enhancing…' : 'Enhance prompt'}
        </button>
      </div>
      {/* Folded away, because it is set once and then left alone - but the
          summary says when one is in force, so a prompt being rewritten by
          instructions you forgot you pasted is never a silent surprise. */}
      {/* A section of its own, like Prompt and Camera either side of it.
          This was a collapsed grey line and it was missed twice - a thing that
          rewrites every prompt on the tab should not be quieter than the
          dropdowns below it. */}
      <h4>LLM system prompt</h4>
      <textarea
        className="prompt-editor"
        rows={4}
        value={systemPrompt}
        placeholder={`What to do with every ${cfg.heading.toLowerCase()} clip made here — e.g. "Locked-off camera, no moves. Keep every line of dialogue word for word." Generate rewrites each clip's prompt under this before rendering. Leave empty and nothing is rewritten.`}
        onChange={(e) => setSystemPrompt(e.target.value)}
      />
      <p className="empty">
        {systemPrompt.trim() ? (
          <>
            <strong>In force</strong> — every Generate on this tab is rewritten under it first, and the
            rewritten prompt appears in the box above so what renders is what you can see.{' '}
            <strong>Enhance prompt</strong> runs the same rewrite without rendering. If it fails, or your
            instructions drop a line of dialogue, nothing is rendered and the reason is shown.
          </>
        ) : (
          <>
            Empty — prompts are sent as written. Paste one here and it is applied at{' '}
            <strong>Generate</strong>, and kept for this tab across movies and reloads.
          </>
        )}
      </p>
      {systemPrompt.trim() && (
        <div className="upload-form">
          <button type="button" onClick={() => setSystemPrompt('')}>
            Clear system prompt
          </button>
        </div>
      )}
      <h4>Camera</h4>
      <div className="camera-row">
        {CAMERA_AXES.filter((a) => cfg.cameraAxes.includes(a.key)).map((axis) => (
          <label key={axis.key} title={axis.hint}>
            {axis.label}
            <Select
              value={camera[axis.key] ?? ''}
              onValueChange={(v) => setCamera((c) => ({ ...c, [axis.key]: v }))}
              placeholder="any"
              items={[
                { value: '', label: 'any' },
                ...cameraPresets
                  .filter((p) => p.category === axis.key)
                  .map((p) => ({ value: p.id, label: p.name }))
              ]}
            />
          </label>
        ))}
        {Object.values(camera).some(Boolean) && (
          <button type="button" onClick={() => setCamera({})}>
            Clear
          </button>
        )}
      </div>
      {/* Shown rather than hidden: it is appended to the prompt at render time,
          and a render is expensive enough to be worth seeing first. */}
      {cameraInstruction(cameraPresets, camera) && (
        <p className="empty">{cameraInstruction(cameraPresets, camera)}</p>
      )}
      {cfg.cameraAxes.length < CAMERA_AXES.length && (
        <p className="empty">
          Shot size, angle and lens are already fixed by the first frame, so only the move and the
          look are offered here — asserting a framing the picture contradicts only fights it.
        </p>
      )}
      <input
        type="text"
        className="motion-request"
        placeholder="Motion request for Enhance (e.g. slow push-in, he looks up from the screen)"
        value={motionRequest}
        onChange={(e) => setMotionRequest(e.target.value)}
      />
      {enhanceStatus && enhanceStatus.state !== 'running' && (
        <p className={enhanceStatus.state === 'error' ? 'error' : 'run-status-ok'}>{enhanceStatus.message}</p>
      )}
      <textarea
        className="prompt-editor"
        rows={8}
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        placeholder={cfg.promptHint}
      />

      <h4>Output</h4>
      {cfg.allowSpectrum && (
        <>
          <label className="upload-form">
            <input type="checkbox" checked={useSpectrum} onChange={(e) => setUseSpectrum(e.target.checked)} />
            <span>Spectrum acceleration</span>
          </label>
          <p className="empty">
            Skips part of the model's work and predicts the result instead, which renders faster. It is an
            approximation: output differs from an unaccelerated render even at the same seed, most visibly in motion
            and fine detail. Worth an A/B on a shot you care about before trusting it. Audio is left untouched.
          </p>
        </>
      )}
      <div className="upload-form">
        <Select
          value={String(resIndex)}
          onValueChange={(v) => setResIndex(Number(v))}
          items={[
            ...RESOLUTIONS.map((r, i) => ({ value: String(i), label: r.label })),
            { value: String(CUSTOM_RES), label: 'Custom…' }
          ]}
        />
        {resIndex === CUSTOM_RES && (
          <>
            <label>
              W{' '}
              <input
                className="res-custom"
                type="number"
                min={256}
                max={1920}
                step={16}
                value={customW}
                onChange={(e) => setCustomW(e.target.value)}
              />
            </label>
            <label>
              H{' '}
              <input
                className="res-custom"
                type="number"
                min={256}
                max={1920}
                step={16}
                value={customH}
                onChange={(e) => setCustomH(e.target.value)}
              />
            </label>
          </>
        )}
        <label>
          Duration (s){' '}
          <input
            type="number"
            min={1}
            max={15}
            step={1}
            value={durationSeconds}
            onChange={(e) => setDurationSeconds(Number(e.target.value))}
          />
        </label>
        <span className="badge">{length} frames @ 24fps</span>
        {resIndex === CUSTOM_RES && (
          <span className="badge" title="Both axes are snapped to a multiple of 16, which the video VAE requires">
            renders {resolution.width} × {resolution.height}
          </span>
        )}
      </div>
      {suggestion && (
        <p className={suggestion.overruns ? 'error' : 'empty'}>
          {suggestion.driver === 'dialogue'
            ? `Dialogue in this beat estimates at ~${suggestion.estimatedSeconds.toFixed(1)}s.`
            : suggestion.driver === 'action'
              ? `Action in this beat estimates at ~${suggestion.estimatedSeconds.toFixed(1)}s.`
              : 'This beat has no dialogue or action text, so the default staging length is used.'}
          {length === MIN_FRAMES && suggestion.estimatedSeconds * 24 < MIN_FRAMES &&
            ` MiniMax cannot go below ${(MIN_FRAMES / 24).toFixed(2)}s, so it is floored there.`}
          {suggestion.overruns &&
            ` That is past the ${(MAX_FRAMES / 24).toFixed(2)}s a single clip can hold - split the beat across shots, or the speech will be cut off.`}
        </p>
      )}

      <button
        type="button"
        disabled={
          status?.state === 'running' || !!blockedReason
        }
        onClick={handleGenerate}
      >
        {status?.state === 'running' ? 'Submitting…' : 'Generate'}
      </button>
      <button type="button" onClick={loadClips}>
        Refresh
      </button>
      {status && status.state !== 'running' && (
        <p className={status.state === 'error' ? 'error' : 'run-status-ok'}>{status.message}</p>
      )}
      {status?.state !== 'running' && blockedReason && (
        <p className="empty">
          Generate needs: {blockedReason}.
          {/* Said here because the two boxes are easy to mistake for each other.
              The system prompt is an instruction ABOUT a prompt - it shapes the
              one in the Prompt box, and cannot stand in for it, so a system
              prompt with an empty Prompt box leaves this button doing nothing
              with no explanation. */}
          {systemPrompt.trim() && !prompt.trim() && (
            <>
              {' '}Your LLM system prompt says how to rewrite a prompt — it is not the prompt itself.
              Put the shot in the <strong>Prompt</strong> box (or press <strong>Fill from beat</strong>) and
              it will be rewritten under your instructions.
            </>
          )}
        </p>
      )}

      <h4>Generations</h4>
      {clips.length === 0 && <p className="empty">Nothing generated yet for {movie.title}.</p>}
      <div className="clip-grid">
      {clips.map((clip) => (
        <div className="beat-card" key={clip.id}>
          <p>
            {new Date(clip.created_at).toLocaleString()} — <span className="badge">{clip.mode}</span>{' '}
            {clip.source_clip_id && <span className="badge">continues {clip.source_clip_id.slice(0, 8)}</span>}{' '}
            <span className="badge">{clip.status}</span>{' '}
            {clip.use_spectrum && (
              <span className="badge" title="Rendered with Spectrum acceleration - approximate, so not directly comparable to an unaccelerated take">
                spectrum
              </span>
            )}{' '}
            — {clip.width}x{clip.height}, {clip.length} frames
            {clip.error_message && <span className="error"> — {clip.error_message}</span>}
          </p>
          <p className="empty">{clip.prompt.slice(0, 220)}{clip.prompt.length > 220 ? '…' : ''}</p>
          {clip.video_path && (
            <video className="shot-preview" src={comfyViewUrl(clip.video_path)} controls preload="metadata" />
          )}
          {clip.status === 'complete' && clip.video_path && clip.length >= 22 && clip.mode !== 'graded' && (
            <button
              type="button"
              disabled={extending !== null}
              onClick={() => {
                setPickFor(clip.id)
                setPickFrame(clip.length - 1)
              }}
            >
              {extending === clip.id ? 'Extending…' : 'Extend this clip'}
            </button>
          )}
          {pickFor === clip.id && clip.video_path && (
            <FramePicker
              src={comfyViewUrl(clip.video_path)}
              frames={clip.length}
              /* Extend anchors a 22-frame window, so the handle cannot sit
                 earlier than frame 21 - there would be no source behind it. */
              minFrame={21}
              value={pickFrame}
              onChange={setPickFrame}
              busy={extending !== null}
              onGrab={(png, frame) => handleGrabFrame(clip, png, frame)}
              onCancel={() => {
                setPickFor(null)
                setGrabbed(null)
              }}
              onConfirm={() => {
                setPickFor(null)
                setGrabbed(null)
                handleExtend(clip, pickFrame >= clip.length - 1 ? null : pickFrame)
              }}
            />
          )}
          {pickFor === clip.id && grabbed && <p className="empty frame-grabbed">{grabbed}</p>}
          {clip.status === 'complete' && clip.video_path && clip.mode !== 'graded' && (
            <GradeControl movie={movie} kind="clip" target={clip.id} onGraded={loadClips} />
          )}
          {clip.mode !== 'graded' && (
          <button
            type="button"
            onClick={() => {
              // The camera line comes back off the prompt and into the
              // dropdowns it came from, so re-rendering does not stack a second
              // one on top.
              setPrompt(stripCameraLine(clip.prompt))
              setCamera((clip.camera ?? {}) as Partial<Record<CameraCategory, string>>)
              const idx = RESOLUTIONS.findIndex((r) => r.width === clip.width && r.height === clip.height)
              if (idx >= 0) setResIndex(idx)
              else {
                // A clip rendered at a custom size loads back as custom rather
                // than silently snapping to the first preset.
                setResIndex(CUSTOM_RES)
                setCustomW(String(clip.width))
                setCustomH(String(clip.height))
              }
              setDurationSeconds(Math.max(1, Math.round(clip.length / 24)))
              if (clip.mode === 'i2v_first_last') setImageMode('first_last')
              if (clip.mode === 'i2v_first') setImageMode('first')
              setUseSpectrum(!!clip.use_spectrum)
              if (clip.beat_id) setBeatId(clip.beat_id)
            }}
          >
            Load settings into form
          </button>
          )}
          {confirmDelete === clip.id ? (
            <div className="clip-delete-confirm">
              <p>
                Delete this clip?
                {deleteImpact === null && ' Checking what else it affects…'}
                {deleteImpact !== null && deleteImpact.extensions > 0 &&
                  ` ${deleteImpact.extensions} clip${deleteImpact.extensions === 1 ? '' : 's'} continue${deleteImpact.extensions === 1 ? 's' : ''} from it — they are kept, but lose the link back.`}
                {deleteImpact !== null && deleteImpact.revoiced > 0 &&
                  ` Its post-voice version is deleted too.`}
                {deleteImpact !== null && " The rendered file stays in ComfyUI's output folder."}
              </p>
              <button
                type="button"
                className="danger"
                disabled={deletingClip === clip.id}
                onClick={() => handleDeleteClip(clip)}
              >
                {deletingClip === clip.id ? 'Deleting…' : 'Delete clip'}
              </button>
              <button
                type="button"
                onClick={() => {
                  setConfirmDelete(null)
                  setDeleteImpact(null)
                }}
              >
                Cancel
              </button>
            </div>
          ) : (
            <button type="button" className="danger" onClick={() => askDeleteClip(clip)}>
              Delete clip
            </button>
          )}
        </div>
      ))}
      </div>
    </div>
  )
}
