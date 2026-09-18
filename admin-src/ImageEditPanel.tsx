import { useEffect, useRef, useState } from 'react'
import { insforge, comfyViewUrl, type Movie } from './insforge'
import { uploadToMovie, IMAGE_ACCEPT } from './storage'
import { triggerFlow, parseFlowJson, type RunStatus } from './flowise'
import { deleteAssetFiles, keptNote } from './assets'
import { ImageSelect, type ImageGroup } from './ui/ImageSelect'
import { LoraPicker, activeLoras, loraBaseName, type LoraChoice } from './ui/LoraPicker'
import { loadMovieFrames, frameLabel, frameGroup } from './frames'
import { dedupeByPath } from './imageSources'
import { Select } from './ui/Select'
import { loadPalettes, paletteInstruction, type Palette } from './palettes'
import { GradeControl } from './ui/GradeControl'
import { LightControl } from './ui/LightControl'
import { FaceFixControl } from './ui/FaceFixControl'

// FLUX.2 Klein editing, driven from here instead of from ComfyUI.
//
// The model takes several reference images at once - a character from one, a
// location from another - so a scene can be composed by describing it rather
// than by wiring a graph. Reference ORDER is meaningful: the prompt refers to
// "the first reference image", so the list is ordered and reorderable.
type Ref = {
  // A ComfyUI-relative path (characters, panoramas) or an InsForge storage key
  // (anything uploaded here). One or the other, never both.
  path?: string
  storageKey?: string
  label: string
  preview?: string
}

type Edit = {
  id: string
  prompt: string
  reference_labels: string[]
  output_path: string | null
  status: string
  width: number
  height: number
  steps: number
  seed: number | null
  lora_name: string | null
  lora_strength: number | null
  loras: { name: string; strength: number }[] | null
  engine: string | null
  reference_paths: string[] | null
  error_message: string | null
  created_at: string
}

// A source is either a ComfyUI path (generated images) or an InsForge storage
// key (anything the operator uploaded). Uploads were skipped entirely before,
// so your own reference could not be picked here at all.
type Source = { path?: string; storageKey?: string; label: string; group: string; id: string }

// The two renderers this tab can drive. They differ in more than a flow id:
// Qwen hands its references to the text encoder as image1..image3 (so three is
// a hard ceiling) and runs a 4-step distilled checkpoint, while Klein chains
// ReferenceLatents and wants 8.
const ENGINES = {
  flux: {
    label: 'FLUX.2 Klein',
    flowId: import.meta.env.VITE_IMAGE_EDIT_ID,
    maxRefs: 4,
    steps: '8',
    size: '1280 × 720 (16:9)',
    note: 'Klein takes a couple of minutes at this size.'
  },
  qwen: {
    label: 'Qwen Image Edit',
    flowId: import.meta.env.VITE_QWEN_IMAGE_EDIT_ID,
    maxRefs: 3,
    steps: '4',
    size: '1024 × 1024 (square)',
    note: 'Qwen-Rapid is a 4-step checkpoint - usually under a minute.'
  },
  // maxRefs 0 is the whole story: Z-Image generates, it does not edit. Its
  // reference path needs the Omni checkpoint, which Tongyi has not released -
  // the Turbo weights cannot consume the reference latents and the sampler
  // fails outright. Offering a reference picker that breaks would be worse
  // than not offering one.
  zimage: {
    label: 'Z-Image Turbo',
    flowId: import.meta.env.VITE_Z_IMAGE_ID,
    maxRefs: 0,
    steps: '8',
    size: '1024 × 1024 (square)',
    note: 'Z-Image generates from the prompt alone - about 7 seconds. No reference images.'
  }
} as const

type EngineKey = keyof typeof ENGINES

const SIZES = [
  { label: '1280 × 720 (16:9)', w: 1280, h: 720 },
  { label: '1920 × 1080 (16:9)', w: 1920, h: 1080 },
  { label: '1024 × 1024 (square)', w: 1024, h: 1024 },
  { label: '832 × 1216 (portrait)', w: 832, h: 1216 },
  { label: '1536 × 640 (wide)', w: 1536, h: 640 }
]

// Same as the video tabs: a sentinel index for "Custom…", with both axes
// snapped to a multiple of 16 - the latent grid all three engines work on.
const CUSTOM_SIZE = -1

function snap16(v: number, fallback: number) {
  if (!Number.isFinite(v) || v <= 0) return fallback
  return Math.min(2048, Math.max(256, Math.round(v / 16) * 16))
}

export function ImageEditPanel({ movie }: { movie: Movie }) {
  const [sources, setSources] = useState<Source[]>([])
  const [refs, setRefs] = useState<Ref[]>([])
  const [prompt, setPrompt] = useState('')
  const [engine, setEngine] = useState<EngineKey>('flux')
  const [sizeIndex, setSizeIndex] = useState(0)
  const [customW, setCustomW] = useState('1280')
  const [customH, setCustomH] = useState('720')
  const size =
    sizeIndex === CUSTOM_SIZE
      ? { w: snap16(Number(customW), 1024), h: snap16(Number(customH), 1024) }
      : SIZES[sizeIndex]
  const [steps, setSteps] = useState('8')
  // No LoRA by default - they are picked per edit, since which one helps
  // depends entirely on the references and the look being aimed at.
  const [loras, setLoras] = useState<LoraChoice[]>([])
  const [palettes, setPalettes] = useState<Palette[]>([])
  const [paletteId, setPaletteId] = useState('')
  const [edits, setEdits] = useState<Edit[]>([])
  const [status, setStatus] = useState<RunStatus | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [uploading, setUploading] = useState(false)
  // Which picture is being evaluated, and what the evaluation said about it.
  // Kept per row rather than as one panel-wide message: the verdict belongs
  // to the picture it is about, and a single line at the top would be read
  // as being about the wrong one.
  // The same loop at the moment of generating, before there is a card to put
  // a button on. Held apart from `status` so the Generate button is not made
  // to describe a loop it is not running.
  const [reviewing, setReviewing] = useState(false)
  const [reviewNote, setReviewNote] = useState<string | null>(null)
  const [judging, setJudging] = useState<string | null>(null)
  const [verdict, setVerdict] = useState<Record<string, string>>({})
  const madeUrls = useRef<string[]>([])
  const maxRefs = ENGINES[engine].maxRefs
  const chosenPalette = palettes.find((p) => p.id === paletteId) ?? null

  useEffect(() => {
    loadPalettes(movie.id).then(setPalettes)
  }, [movie.id])

  async function loadSources() {
    const out: Source[] = []
    const { data: chars } = await insforge.database
      .from('characters')
      .select('id,name')
      .eq('movie_id', movie.id)
      .order('name', { ascending: true })
    const ids = (chars ?? []).map((c: { id: string }) => c.id)
    if (ids.length) {
      const { data: imgs } = await insforge.database
        .from('character_images')
        .select('id,character_id,kind,version,image_path,storage_key,source')
        .filter('character_id', 'in', `(${ids.join(',')})`)
        .order('version', { ascending: false })
      const byId = new Map((chars ?? []).map((c: { id: string; name: string }) => [c.id, c.name]))
      for (const im of imgs ?? []) {
        // Uploads live in storage with no image_path, and were skipped entirely
        // before - so a reference you added yourself could not be picked here.
        if (!im.image_path && !im.storage_key) continue
        const who = byId.get(im.character_id) ?? '?'
        const mine = im.source && /^upload/i.test(im.source) ? ' (yours)' : ''
        out.push({
          id: im.id,
          path: im.image_path ?? undefined,
          storageKey: im.image_path ? undefined : im.storage_key,
          label: `${who} — ${im.kind} v${im.version}${mine}`,
          group: 'Characters'
        })
      }
    }
    const { data: panos } = await insforge.database
      .from('scene_panos')
      .select('act_number,scene_number,image_path')
      .eq('movie_id', movie.id)
      .order('act_number', { ascending: true })
    for (const p of panos ?? []) {
      if (!p.image_path) continue
      out.push({
        id: `pano-${p.act_number}-${p.scene_number}`,
        path: p.image_path,
        label: `A${p.act_number}S${p.scene_number} panorama`,
        group: 'World'
      })
    }

    // Cleaned-up frames are usually the best plate a scene has - a corrected
    // splat angle rather than a raw render - so they belong in the picker
    // alongside characters and panoramas.
    const { data: cleanups } = await insforge.database
      .from('qwen_cleanups')
      .select('act_number,scene_number,cleaned_image_path,created_at')
      .eq('movie_id', movie.id)
      .eq('status', 'complete')
      .order('created_at', { ascending: false })
    for (const c of cleanups ?? []) {
      if (!c.cleaned_image_path) continue
      const where = c.act_number != null && c.scene_number != null ? `A${c.act_number}S${c.scene_number}` : 'no scene'
      out.push({
        id: `cleanup-${c.created_at}`,
        path: c.cleaned_image_path,
        label: `${where} — ${new Date(c.created_at).toLocaleDateString()}`,
        group: 'Cleanups'
      })
    }

    // Previous edits, so a composition can be built on rather than restarted.
    const { data: prior } = await insforge.database
      .from('image_edits')
      .select('id,prompt,output_path,created_at,engine')
      .eq('movie_id', movie.id)
      .eq('status', 'complete')
      .order('created_at', { ascending: false })
    for (const e of prior ?? []) {
      if (!e.output_path) continue
      const isFaceFix = e.engine === 'face_fix'
      out.push({
        id: `edit-${e.id}`,
        path: e.output_path,
        label: `${new Date(e.created_at).toLocaleDateString()} — ${
          isFaceFix ? String(e.prompt) : String(e.prompt).slice(0, 40)
        }`,
        group: isFaceFix ? 'Face fixes' : 'Edits'
      })
    }

    // Frames grabbed out of rendered clips. They live in the movie's own
    // folder, so they are addressed exactly like every other source here.
    for (const f of await loadMovieFrames(movie.id)) {
      out.push({ id: `frame-${f.id}`, path: f.image_path, label: frameLabel(f), group: frameGroup(f) })
    }

    setSources(dedupeByPath(out))
    await loadEdits()
  }

  useEffect(() => {
    loadSources()
    setRefs([])
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [movie.id])

  // Object URLs for uploaded previews are revoked only on unmount - revoking
  // them when refs change would kill the URL of an image still on screen.
  useEffect(() => {
    return () => {
      madeUrls.current.forEach((u) => URL.revokeObjectURL(u))
      madeUrls.current = []
    }
  }, [])

  async function loadEdits() {
    const { data } = await insforge.database
      .from('image_edits')
      .select('*')
      .eq('movie_id', movie.id)
      .order('created_at', { ascending: false })
    setEdits((data ?? []) as Edit[])
  }

  async function addSource(id: string) {
    const s = sources.find((x) => x.id === id)
    if (!s || refs.length >= maxRefs) return
    if (s.path) {
      setRefs((prev) => [...prev, { path: s.path, label: s.label, preview: comfyViewUrl(s.path as string) }])
      return
    }
    if (!s.storageKey) return
    // Stored images are not reachable by URL, so the preview needs the blob.
    // Only the picked ones are downloaded, never the whole list.
    const { data } = await insforge.storage.from(movie.bucket_name).download(s.storageKey)
    let preview: string | undefined
    if (data) {
      preview = URL.createObjectURL(data)
      madeUrls.current.push(preview)
    }
    setRefs((prev) => [...prev, { storageKey: s.storageKey, label: s.label, preview }])
  }

  async function addFile(file: File) {
    if (refs.length >= maxRefs) return
    setUploading(true)
    setError(null)
    const r = await uploadToMovie(movie, 'image-edit', file)
    if ('error' in r) {
      setError(r.error)
      setUploading(false)
      return
    }
    const url = URL.createObjectURL(file)
    madeUrls.current.push(url)
    setRefs((prev) => [...prev, { storageKey: r.key, label: file.name, preview: url }])
    setUploading(false)
  }

  function move(i: number, delta: number) {
    const j = i + delta
    if (j < 0 || j >= refs.length) return
    setRefs((prev) => {
      const next = [...prev]
      const [item] = next.splice(i, 1)
      next.splice(j, 0, item)
      return next
    })
  }

  function switchEngine(next: EngineKey) {
    if (next === engine) return
    const cfg = ENGINES[next]
    setEngine(next)
    setSteps(cfg.steps)
    // A custom size was chosen on purpose, so an engine switch leaves it alone.
    const idx = SIZES.findIndex((s) => s.label === cfg.size)
    if (idx >= 0 && sizeIndex !== CUSTOM_SIZE) setSizeIndex(idx)
    // Qwen has three image inputs and Klein four, so moving across can leave a
    // reference that has nowhere to go. Dropping it here is clearer than a
    // failure at render time.
    setRefs((r) => r.slice(0, cfg.maxRefs))
    setError(null)
  }

  /**
   * Renders, and now also RETURNS what it rendered.
   *
   * Everything it did before it still does - the running state, the error, the
   * reload of the list. The return value is for `handleGenerateReviewed`, which
   * needs the path of the picture that was just made. Reading that back as the
   * newest row would be a guess: a render started elsewhere, or a graded copy
   * landing in between, would hand it the wrong picture to judge.
   */
  async function handleGenerate(): Promise<{ outputPath: string; prompt: string } | null> {
    setStatus({ state: 'running', message: '' })
    setError(null)
    // Built once and kept, so the review judges the same words the model was
    // given rather than a reconstruction of them.
    const asked = chosenPalette ? `${prompt}\n\n${paletteInstruction(chosenPalette)}` : prompt
    const r = await triggerFlow(ENGINES[engine].flowId, {
      movieId: movie.id,
      // The grade is appended, never substituted: the operator's prompt says
      // what the picture is, the palette says only how it is coloured.
      prompt: asked,
      references: refs.map((x) =>
        x.path ? { path: x.path, label: x.label } : { storageKey: x.storageKey, label: x.label }
      ),
      width: size.w,
      height: size.h,
      steps: Number(steps) || Number(ENGINES[engine].steps),
      loras: activeLoras(loras),
      paletteId: paletteId || null
    })
    setStatus(null)
    const res = parseFlowJson<{ action: string; reason?: string; outputPath?: string }>(r)
    await loadEdits()
    if (!res.ok) {
      setError(res.message)
      return null
    }
    if (res.data.action === 'error') {
      setError(res.data.reason ?? 'The render failed.')
      return null
    }
    return res.data.outputPath ? { outputPath: res.data.outputPath, prompt: asked } : null
  }

  /**
   * Generate, review what came out, and generate again if it is not what the
   * prompt asked for.
   *
   * The same judgement `evaluateAndRedo` makes on an existing card, moved to
   * the moment of generating so a wrong picture is caught before it is looked
   * at rather than after. It shares the review flow, so the two agree by
   * construction: what one calls wrong, the other does too.
   *
   * Three attempts at most. Each is a fresh seed on the SAME prompt, so three
   * misses of the same thing means the prompt is at fault and a fourth render
   * will not fix it. The note says what went missing, so it can be reworded.
   */
  async function handleGenerateReviewed() {
    const checkId = import.meta.env.VITE_IMAGE_CHECK_ID
    if (!checkId) {
      setError('VITE_IMAGE_CHECK_ID is not set - add it to .env and restart the dev server.')
      return
    }
    setReviewing(true)
    setReviewNote(null)
    try {
      const MAX = 3
      for (let attempt = 1; attempt <= MAX; attempt++) {
        setReviewNote(`Rendering, attempt ${attempt} of ${MAX}…`)
        const made = await handleGenerate()
        // handleGenerate has already said why on screen.
        if (!made) return

        setReviewNote(`Reviewing attempt ${attempt}…`)
        const res = parseFlowJson<{ ok: boolean; why?: string; missing?: string[] }>(
          await triggerFlow(checkId, { imagePath: made.outputPath, prompt: made.prompt })
        )
        // A review that could not run is NOT a failed picture. Rendering again
        // on that basis would discard something nobody ever judged.
        if (!res.ok) {
          setReviewNote(`Rendered. The review could not run, so it was kept: ${res.message}`)
          return
        }
        if (res.data.ok) {
          setReviewNote(
            attempt === 1
              ? 'Reviewed: it shows what was asked for.'
              : `Reviewed: attempt ${attempt} shows what was asked for.`
          )
          return
        }
        const why = res.data.why || (res.data.missing ?? []).join(', ') || 'it did not match the prompt'
        if (attempt === MAX) {
          setReviewNote(
            `Stopped after ${MAX} attempts, all wrong the same way: ${why}. Three seeds missing the same thing is the prompt, not the render — reword it.`
          )
          return
        }
        setReviewNote(`Attempt ${attempt} was wrong: ${why} — rendering again.`)
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setReviewing(false)
    }
  }

  /**
   * Render an edit AGAIN from its own stored settings.
   *
   * Not from the form. The form holds whatever was typed last, which is
   * usually something else entirely - a redo driven by it would quietly make a
   * different picture and call it the same one. Everything comes off the row:
   * its prompt, its references, its size, its steps, its LoRAs, its engine.
   *
   * The palette is already baked into the stored prompt (it is appended at
   * render time, not applied afterwards), so no paletteId is sent - passing one
   * would append the grading instruction a second time.
   */
  async function renderAgain(e: Edit): Promise<{ outputPath: string } | { error: string }> {
    const key = (e.engine ?? 'flux') as EngineKey
    const cfg = ENGINES[key]
    if (!cfg) return { error: `a ${e.engine} image is derived from another picture, so there is nothing to re-render` }

    // A row that names references but does not record their paths predates the
    // column. Re-rendering it without them would produce an unrelated picture
    // from the same words - worse than not redoing it at all.
    const labels = e.reference_labels ?? []
    const sources = e.reference_paths ?? []
    if (labels.length > 0 && sources.length === 0) {
      return { error: 'this one was made before reference paths were recorded, so it cannot be reproduced' }
    }
    const references = sources.map((src, i) =>
      /^(output|input)\//i.test(src)
        ? { path: src, label: labels[i] ?? '' }
        : { storageKey: src, label: labels[i] ?? '' }
    )

    const r = await triggerFlow(cfg.flowId, {
      movieId: movie.id,
      prompt: e.prompt,
      references,
      width: e.width,
      height: e.height,
      steps: e.steps || Number(cfg.steps),
      loras: e.loras?.length ? e.loras : e.lora_name ? [{ name: e.lora_name, strength: e.lora_strength ?? 1 }] : [],
      paletteId: null
    })
    const res = parseFlowJson<{ action: string; reason?: string; outputPath?: string }>(r)
    if (!res.ok) return { error: res.message }
    if (res.data.action === 'error') return { error: res.data.reason ?? 'the render failed' }
    if (!res.data.outputPath) return { error: 'the render finished without an image' }
    return { outputPath: res.data.outputPath }
  }

  /**
   * Look at this picture, and render it again if it is not what its prompt
   * asked for.
   *
   * The evaluation is narrow on purpose. It asks one thing - are the people and
   * objects the prompt named actually in the frame, once each, and not swapped
   * for something else - and says nothing about whether the picture is any
   * good. A model asked to judge quality answers confidently and wrongly, and
   * would throw away renders that were fine.
   *
   * Two redos at most. Each is a fresh seed on the SAME prompt, so if the redo
   * misses the same thing again the prompt is at fault and a third render will
   * not fix it. The verdict names what went missing so it can be reworded.
   *
   * The redos are added as new rows; nothing is overwritten and nothing is
   * deleted. The original stays there to be compared against, and thrown out by
   * hand if the redo is better.
   */
  async function evaluateAndRedo(e: Edit) {
    const checkId = import.meta.env.VITE_IMAGE_CHECK_ID
    if (!checkId) {
      setError('VITE_IMAGE_CHECK_ID is not set - add it to .env and restart the dev server.')
      return
    }
    const say = (m: string) => setVerdict((v) => ({ ...v, [e.id]: m }))
    setJudging(e.id)
    setError(null)
    try {
      const MAX_REDOS = 2
      let path = e.output_path as string
      for (let round = 0; round <= MAX_REDOS; round++) {
        say(round === 0 ? 'Looking at it…' : `Looking at redo ${round}…`)
        const res = parseFlowJson<{ ok: boolean; why?: string; missing?: string[] }>(
          await triggerFlow(checkId, { imagePath: path, prompt: e.prompt })
        )
        // An evaluation that could not run is NOT a failed picture. Redoing on
        // that basis would spend a render on something nobody ever judged.
        if (!res.ok) {
          say(`Could not evaluate it, so it was left alone: ${res.message}`)
          return
        }
        if (res.data.ok) {
          say(round === 0 ? 'Matches the prompt — nothing to redo.' : `Redo ${round} matches the prompt.`)
          return
        }
        const why = res.data.why || (res.data.missing ?? []).join(', ') || 'it does not match the prompt'
        if (round === MAX_REDOS) {
          say(
            `Still wrong after ${MAX_REDOS} redos: ${why}. Three seeds missing the same thing is the prompt, not the render — reword it.`
          )
          return
        }
        say(`Wrong: ${why} — rendering it again…`)
        const made = await renderAgain(e)
        if ('error' in made) {
          say(`Wrong: ${why}. The redo could not run: ${made.error}`)
          return
        }
        path = made.outputPath
        await loadEdits()
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setJudging(null)
      await loadEdits()
    }
  }

  async function handleDelete(e: Edit) {
    // Row first, then the file: the delete flow keeps any file a row still
    // points at, and this row is one of those until it is gone.
    await insforge.database.from('image_edits').delete().eq('id', e.id)
    const r = await deleteAssetFiles([e.output_path])
    const note = keptNote(r)
    if (note) setError(note)
    await loadEdits()
  }

  const running = status?.state === 'running'
  // References are optional: with none, Klein generates from the prompt alone.
  const blocked = !prompt.trim() ? 'a prompt' : ''
  // Rows written before the engine column existed are all Klein.
  //
  // Graded copies carry engine 'grade', so filtering on the engine tab alone
  // hid every one of them: the Grade button reported success and nothing
  // appeared, which reads as the palette silently not applying. A graded copy
  // is shown beside the picture it was made from, and a grade of something
  // that is not an edit at all - a character still, a saved frame - is shown
  // here too, because it has nowhere else to appear.
  const shownEdits = (() => {
    const own = edits.filter((e) => (e.engine ?? 'flux') === engine)
    const ownOutputs = new Set(own.map((e) => e.output_path).filter(Boolean) as string[])
    const anyEditOutput = new Set(edits.map((e) => e.output_path).filter(Boolean) as string[])
    const graded = edits.filter((e) => {
      if (e.engine !== 'grade') return false
      const from = e.reference_paths?.[0]
      if (!from) return true
      return ownOutputs.has(from) || !anyEditOutput.has(from)
    })
    return [...own, ...graded].sort((a, b) => b.created_at.localeCompare(a.created_at))
  })()

  const grouped = sources.reduce<Record<string, Source[]>>((acc, s) => {
    ;(acc[s.group] = acc[s.group] ?? []).push(s)
    return acc
  }, {})

  // Order the families so the ones picked most often sit at the top.
  const GROUP_ORDER = [
    'Characters',
    'World',
    'Cleaned plates',
    'Face fixes',
    'Splat Snapshots',
    'Panorama Snapshots',
    'Cleanups',
    'Edits',
    'Frames'
  ]
  const pickerGroups: ImageGroup[] = GROUP_ORDER.filter((g) => grouped[g]?.length).map((g) => ({
    label: g,
    items: grouped[g].map((s) => ({
      value: s.id,
      label: s.label,
      thumb: s.path ? comfyViewUrl(s.path) : undefined
    }))
  }))

  return (
    <div>
      <p>
        Edits images using the references you pick. Give it a character and a location and describe the shot - the
        prompt can refer to them in order, as "the first reference image" and "the second". Results stay here, so scenes
        can be composed without opening ComfyUI.
      </p>

      <div className="engine-switch" role="group" aria-label="Renderer">
        {(Object.keys(ENGINES) as EngineKey[]).map((k) => (
          <button
            type="button"
            key={k}
            className={'engine-tab' + (engine === k ? ' is-active' : '')}
            aria-pressed={engine === k}
            disabled={running}
            onClick={() => switchEngine(k)}
          >
            {ENGINES[k].label}
          </button>
        ))}
      </div>

      {maxRefs > 0 ? (
        <>
          <h4>Reference images</h4>
          <p className="empty">
            Optional. Pick up to {maxRefs} to carry a character, a location or a look across — or leave this empty and
            generate from the prompt alone.
          </p>
          <div className="upload-form">
            <ImageSelect
              value=""
              resetAfterPick
              disabled={refs.length >= maxRefs}
              placeholder="Add from this movie…"
              groups={pickerGroups}
              onValueChange={(id) => addSource(id)}
            />
            <label className="empty">
              or from file{' '}
              <input
                type="file"
                accept={IMAGE_ACCEPT}
                disabled={uploading || refs.length >= maxRefs}
                onChange={(e) => {
                  const f = e.target.files?.[0]
                  if (f) addFile(f)
                  e.currentTarget.value = ''
                }}
              />
            </label>
          </div>
          {refs.length >= maxRefs && (
            <p className="empty">
              {maxRefs} references is the limit for {ENGINES[engine].label} — remove one to add another.
            </p>
          )}

          {refs.length > 0 && (
            <div className="edit-refs">
              {refs.map((r, i) => (
                <div className="edit-ref" key={`${r.path ?? r.storageKey}-${i}`}>
                  {r.preview && <img src={r.preview} alt={r.label} />}
                  <div className="edit-ref-body">
                    {/* The number is not decoration - the prompt refers to it. */}
                    <span className="badge">#{i + 1}</span> <span>{r.label}</span>
                  </div>
                  <div className="edit-ref-actions">
                    <button type="button" disabled={i === 0} onClick={() => move(i, -1)} title="Move earlier">
                      ↑
                    </button>
                    <button
                      type="button"
                      disabled={i === refs.length - 1}
                      onClick={() => move(i, 1)}
                      title="Move later"
                    >
                      ↓
                    </button>
                    <button
                      type="button"
                      className="danger"
                      onClick={() => setRefs((prev) => prev.filter((_, k) => k !== i))}
                    >
                      Remove
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </>
      ) : (
        <p className="empty">
          {ENGINES[engine].label} generates from the prompt alone — it has no reference-image path yet, so there is
          nothing to pick here.
        </p>
      )}

      <h4>What to make</h4>
      <textarea
        className="prompt-editor"
        rows={4}
        placeholder="e.g. Place the character from the first reference image standing in the location from the second. Keep her face and costume exactly. Wide cinematic shot, night."
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
      />
      <div className="upload-form">
        <label>
          Size
          <select value={sizeIndex} onChange={(e) => setSizeIndex(Number(e.target.value))}>
            {SIZES.map((s, i) => (
              <option key={s.label} value={i}>
                {s.label}
              </option>
            ))}
            <option value={CUSTOM_SIZE}>Custom…</option>
          </select>
        </label>
        {sizeIndex === CUSTOM_SIZE && (
          <>
            <label>
              W{' '}
              <input
                className="res-custom"
                type="number"
                min={256}
                max={2048}
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
                max={2048}
                step={16}
                value={customH}
                onChange={(e) => setCustomH(e.target.value)}
              />
            </label>
            <span className="badge" title="Both axes are snapped to a multiple of 16">
              renders {size.w} × {size.h}
            </span>
          </>
        )}
        <label>
          Steps
          <input type="number" min={1} max={40} value={steps} onChange={(e) => setSteps(e.target.value)} />
        </label>
        <label className="lora-field">
          Palette
          <Select
            value={paletteId}
            onValueChange={setPaletteId}
            placeholder="none"
            items={[{ value: '', label: 'No grade' }, ...palettes.map((p) => ({ value: p.id, label: p.name }))]}
          />
        </label>
        <label className="lora-field">
          LoRAs
          <LoraPicker value={loras} onChange={setLoras} disabled={running} />
        </label>
        <button type="button" disabled={running || reviewing || !!blocked} onClick={handleGenerate}>
          {running && !reviewing ? 'Generating…' : 'Generate'}
        </button>
        {/* The same render, reviewed, with up to two more goes if what was
            asked for is not in the picture. Its own button rather than folded
            into Generate: it can spend three renders instead of one, and that
            should be chosen, not discovered. */}
        <button
          type="button"
          disabled={running || reviewing || !!blocked}
          onClick={handleGenerateReviewed}
          title="Render, review the result against the prompt, and render again up to twice if something asked for is missing"
        >
          {reviewing ? 'Reviewing…' : 'Generate and review'}
        </button>
      </div>
      {chosenPalette && (
        <div className="palette-chosen">
          <div className="palette-strip">
            {chosenPalette.swatches.map((c) => (
              <span key={c} style={{ background: c }} title={c} />
            ))}
          </div>
          <p className="empty">
            Grading toward <strong>{chosenPalette.name}</strong>. This is appended to your prompt — the subject and
            framing stay yours.
          </p>
        </div>
      )}
      {!running && blocked && <p className="empty">Generate needs: {blocked}.</p>}
      {running && <p className="empty">{ENGINES[engine].note}</p>}
      {reviewNote && <p className="empty">{reviewNote}</p>}
      {error && <p className="error">{error}</p>}

      <h4>Edits</h4>
      {shownEdits.length === 0 && (
        <p className="empty">
          Nothing edited yet with {ENGINES[engine].label} for {movie.title}.
        </p>
      )}
      <div className="clip-grid">
        {shownEdits.map((e) => (
          <div className="beat-card" key={e.id}>
            <p>
              {new Date(e.created_at).toLocaleString()} — <span className="badge">{e.status}</span>{' '}
              {e.engine === 'grade' ? (
                <span className="badge">graded</span>
              ) : (
                <span className="badge">
                  {e.width}×{e.height}
                </span>
              )}{' '}
              {(e.loras?.length
                ? e.loras
                : e.lora_name
                ? [{ name: e.lora_name, strength: e.lora_strength ?? 1 }]
                : []
              ).map((l) => (
                <span className="badge" key={l.name}>
                  {loraBaseName(l.name)} {l.strength}
                </span>
              ))}
              {e.error_message && <span className="error"> — {e.error_message}</span>}
            </p>
            {e.output_path && <img className="edit-output" src={comfyViewUrl(e.output_path)} alt={e.prompt} />}
            <p className="empty">
              {e.prompt.slice(0, 200)}
              {e.prompt.length > 200 ? '…' : ''}
            </p>
            {e.reference_labels?.length > 0 && <p className="empty">From: {e.reference_labels.join(' · ')}</p>}
            {verdict[e.id] && <p className="empty">{verdict[e.id]}</p>}
            <div className="edit-ref-actions">
              <button
                type="button"
                onClick={() => {
                  setPrompt(e.prompt)
                  const idx = SIZES.findIndex((s) => s.w === e.width && s.h === e.height)
                  if (idx >= 0) setSizeIndex(idx)
                  else if (e.width && e.height) {
                    setSizeIndex(CUSTOM_SIZE)
                    setCustomW(String(e.width))
                    setCustomH(String(e.height))
                  }
                  setSteps(String(e.steps ?? 8))
                  setLoras(
                    e.loras?.length
                      ? e.loras.map((l) => ({ ...l, enabled: true }))
                      : e.lora_name
                      ? [{ name: e.lora_name, strength: e.lora_strength ?? 1, enabled: true }]
                      : []
                  )
                }}
              >
                Load settings
              </button>
              {e.output_path && e.engine !== 'grade' && (
                <LightControl
                  movie={movie}
                  sourcePath={e.output_path}
                  label={e.prompt.slice(0, 60)}
                  onRelit={loadEdits}
                />
              )}
              {e.output_path && e.engine !== 'grade' && e.engine !== 'face_fix' && (
                <FaceFixControl movie={movie} imagePath={e.output_path} onFixed={loadSources} />
              )}
              {e.output_path && e.engine !== 'grade' && (
                <GradeControl
                  movie={movie}
                  kind="image"
                  target={e.output_path}
                  label={e.prompt.slice(0, 60)}
                  onGraded={loadEdits}
                />
              )}
              {/* Only where there is something to judge and something to redo.
                  A grade, a relight or a face fix is derived from another
                  picture rather than rendered from a prompt, so there is no
                  render to repeat. */}
              {e.output_path && (e.engine ?? 'flux') in ENGINES && (
                <button
                  type="button"
                  disabled={judging !== null || reviewing || running}
                  onClick={() => evaluateAndRedo(e)}
                  title="Check this picture against its own prompt, and render it again if something asked for is missing"
                >
                  {judging === e.id ? 'Working…' : 'Evaluate and redo'}
                </button>
              )}
              <button type="button" className="danger" onClick={() => handleDelete(e)}>
                Delete
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
