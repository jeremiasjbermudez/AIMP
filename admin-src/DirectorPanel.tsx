import { Fragment, useEffect, useRef, useState } from 'react'
import { insforge, comfyViewUrl, type Movie } from './insforge'
import { triggerFlow, parseFlowJson } from './flowise'
import { Select } from './ui/Select'
import { uploadToMovie } from './storage'
import { ImageSelect } from './ui/ImageSelect'
import { loadImageSources, toPickerGroups, type ImageSource } from './imageSources'
import { FramePicker } from './ui/FramePicker'
import { saveFrameToProject } from './frames'
import { ShotCameraBadge } from './ui/ShotCameraBadge'

/**
 * The Director - SKELETON.
 *
 * Plans a movie's shot list from its beats and characters, then produces it
 * stage by stage. Built slowly on purpose: this version only lays out the four
 * parts and reads the real tables. Nothing here generates yet.
 *
 *   1. Plan       - a target runtime; the director flow drafts the shot list
 *   2. Shot list  - every planned shot, in cut order
  *   3. Produce    - the stages, each unlocked by the one before it
 *
 * The shot list carries each shot's frame, its editable prompt and its
 * remedies, so one row is one shot and everything about it.
 *
 * The design, the agreed planning rules and what is built so far are in
 * C:\Flowise\DIRECTOR.md - change a rule there before changing it here.
 */
type Plan = {
  id: string
  target_seconds: number
  status: 'draft' | 'planned' | 'producing' | 'assembled'
  output_path: string | null
  created_at: string
}

type SceneLook = {
  scene_number: number
  location_name: string | null
  key_light: string | null
  screen_direction: string | null
  // Where the fixed things STAND relative to each other. Without it nothing in a
  // frame prompt said where the car was relative to the person beside it, so
  // every shot decided again.
  staging: string | null
  // The look this scene's panorama is rendered in. The generator used to
  // hard-code "photorealistic, cinematic", so an anime film got a photoreal
  // backplate under its cast.
  render_style: string | null
}

type DirectorShot = {
  id: string
  position: number
  scene_number: number | null
  beat_id: string | null
  shot_type: string | null
  // How close the camera is, kept apart from what the shot is for: "reaction"
  // says the job and nothing about the framing.
  shot_size: string | null
  // What the continuity pass found. redo_frame = this frame is wrong on its
  // own; redo_prev / redo_next = it disagrees with a neighbour; needs_shot = a
  // shot is missing between two others.
  review_state: string | null
  review_note: string | null
  // The sentence to append when repairing this shot - why the constraint is
  // stored and not just the complaint.
  review_constraint: string | null
  // The one thing near the lens that gives the frame depth.
  foreground: string | null
  characters: string[]
  length_frames: number
  continuity: 'fresh' | 'continue'
  // 5.8 - the window of the generated clip the cut keeps. use_frames null = all.
  use_start_frame: number
  use_frames: number | null
  frame_prompt: string | null
  motion_prompt: string | null
  notes: string | null
  first_frame_path: string | null
  // The background this shot sits on - a panorama snapshot, a splat capture, or
  // any picture. Shown to the renderer rather than described, because words
  // never hold a location still.
  plate_path: string | null
  // Who is wearing what, in this shot. Both halves, because a costume is not
  // owned by a person - it is worn by one, here. The same vest is a character's in one
  // scene and on Doc in another.
  //   null  - nothing said; fall back to the costume's own worn_by
  //   []    - nobody is wearing a costume
  //   [...] - exactly these people in exactly these costumes
  wardrobe: { prop: string; on: string }[] | null
  frame_approved: boolean
  clip_id: string | null
  status: string
}

/** The coverage the script itself asks for (DIRECTOR.md 5.9). */
type Breakdown = { dialogue: number; reactions: number; establishing: number; action: number }

/** What the planning pass reports back. */
type PlanResult = {
  action: string
  shots: number
  seconds: number
  runtime: string
  targetSeconds: number
  coverageShots: number
  breakdown: Breakdown
  advice: string | null
  perScene: Record<string, number>
  lines: number
  retried: boolean
  fixes: string[]
}

type DryRun = {
  action: string
  beats: number
  scenes: number
  characters: string[]
  lines: number
  shots: number
  runtime: string
  breakdown: Breakdown
  advice: string | null
  note: string
}

// The order production runs in. Each stage is gated by the one before.
const STAGES = [
  { id: 'frames', label: 'First frames' },
  { id: 'review', label: 'Review frames' },
  { id: 'clips', label: 'Clips' },
  { id: 'checks', label: 'Speech & frame checks' },
  { id: 'assemble', label: 'Assemble' }
] as const

/** A character reference image, as Image Edit wants it. */
type CharRef = { path: string; label: string }

/** A character already wearing a costume: one picture instead of two. */
type Dressed = { character: string; prop: string; path: string }

/**
 * How many renders to have in flight at once.
 *
 * ComfyUI runs one job on the GPU at a time whatever we do - the gain is not
 * parallel rendering, it is that its queue is never EMPTY. Submitting one and
 * waiting left the card idle for every HTTP round-trip and poll gap between
 * shots, which across forty shots is minutes of nothing happening.
 *
 * Three, not more: the Image Edit flow gives a job ten minutes before calling it
 * wedged, and a job waiting behind two others is comfortably inside that. A
 * deeper queue would also take longer to unwind when you press Stop.
 */
const IN_FLIGHT = 3

// MiniMax's canvas (DIRECTOR.md 6). Image to Video stretches any other shape.
const FRAME_W = 1344
const FRAME_H = 768

// refsForShot is gone: it returned up to two pictures per person, which made
// the reference list a different length from the number of people the prompt
// names - and the prompt addresses them by position ("the character from the
// first image"). One picture per person, in the order the shot lists them, is
// the only arrangement those ordinals can survive.

/**
 * Run a job over every item, keeping `limit` of them in flight.
 *
 * Stops launching new work as soon as `stop()` goes true or a worker reports a
 * failure - the same fault (ComfyUI down, a missing reference) would fail every
 * remaining shot identically, so ploughing on just wastes the queue.
 */
async function pool<T>(
  items: T[],
  limit: number,
  stop: () => boolean,
  worker: (item: T) => Promise<{ error?: string } | void>
): Promise<{ done: number; error: string | null }> {
  let next = 0
  let done = 0
  let error: string | null = null
  const lane = async () => {
    for (;;) {
      if (error || stop()) return
      const i = next++
      if (i >= items.length) return
      const out = await worker(items[i])
      if (out && 'error' in out && out.error) {
        error = error ?? out.error
        return
      }
      done++
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, lane))
  return { done, error }
}

export function DirectorPanel({ movie }: { movie: Movie }) {
  const [plans, setPlans] = useState<Plan[]>([])
  // The scene's look: where the light comes from, and which way things lie on
  // screen. Held for every shot of the scene, exactly as one sound bed runs the
  // whole scene - which is what stopped the sound changing at every cut.
  const [sceneLook, setSceneLook] = useState<SceneLook[]>([])
  const [planId, setPlanId] = useState('')
  const [shots, setShots] = useState<DirectorShot[]>([])
  const [targetSeconds, setTargetSeconds] = useState(120)
  const [dryRun, setDryRun] = useState<DryRun | null>(null)
  const [planResult, setPlanResult] = useState<PlanResult | null>(null)
  const [drafting, setDrafting] = useState(false)
  // Bumped whenever something on disk changes: a frame rendered, a reference
  // sheet made, a costume dressed.
  //
  // The loaders below - the cast's reference pictures, the props, every image in
  // the movie - were keyed on movie.id alone, so they ran once when the tab
  // mounted and never again. Generate a new reference and the Director kept
  // handing renders the old one; render a frame and the picker still listed what
  // was there before. The only way to see new work was F5 or leaving the tab and
  // coming back, which is a page refresh by another name.
  const [dataVersion, setDataVersion] = useState(0)
  const [clipPaths, setClipPaths] = useState<Record<string, { path: string; frames: number }>>({})
  // Which shot has the frame picker open, and where it is scrubbed to.
  const [grabFor, setGrabFor] = useState<string | null>(null)
  const [grabFrame, setGrabFrame] = useState(0)

  // Keyed by clip_id, so a row can find its own video without a second query
  // per shot. Re-runs with dataVersion: a clip that finished rendering after
  // this loaded would otherwise never appear until the tab was remounted.
  useEffect(() => {
    let live = true
    void (async () => {
      const ids = shots.map((x) => x.clip_id).filter(Boolean) as string[]
      if (!ids.length) {
        if (live) setClipPaths({})
        return
      }
      const { data } = await insforge.database
        .from('minimax_clips')
        .select('id,video_path,length')
        .in('id', ids)
      const out: Record<string, { path: string; frames: number }> = {}
      for (const r of (data ?? []) as { id: string; video_path: string | null; length: number | null }[]) {
        if (r.video_path) out[r.id] = { path: r.video_path, frames: r.length ?? 124 }
      }
      if (live) setClipPaths(out)
    })()
    return () => {
      live = false
    }
  }, [shots, dataVersion])
  const refreshData = () => setDataVersion((n) => n + 1)
  // Spectrum acceleration, decided before the clips are rendered rather than
  // per clip row. It forecasts some of the model's transformer evaluations
  // instead of running them, so it is faster and it is an APPROXIMATION: the
  // same seed gives a different clip, most visibly in motion and fine detail.
  // Off by default, because a whole plan rendered before anyone compared the two
  // is an expensive way to find out you preferred the slow one.
  const [useSpectrum, setUseSpectrum] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // What the last continuity pass said. Its own line rather than an error,
  // because "everything agrees" is a result worth seeing too.
  const [reviewNote, setReviewNote] = useState<string | null>(null)
  // The shimmy form: which position it goes in front of, and what it is.
  // Null means the form is closed.
  const [insertAt, setInsertAt] = useState<number | null>(null)
  const [insAction, setInsAction] = useState('')
  const [insWho, setInsWho] = useState<string[]>([])
  const [insType, setInsType] = useState('action')
  const [insSize, setInsSize] = useState('medium')
  const [insForeground, setInsForeground] = useState('')
  const [insFirstFrame, setInsFirstFrame] = useState('')
  const [insLastFrame, setInsLastFrame] = useState('')
  // Shots ticked for a bulk action. The plate is the first thing that needed
  // it - one storefront, one angle, four shots.
  const [picked, setPicked] = useState<string[]>([])


  const plan = plans.find((p) => p.id === planId) ?? null

  async function loadPlans(select?: string) {
    const { data, error: e } = await insforge.database
      .from('director_plans')
      .select('*')
      .eq('movie_id', movie.id)
      .order('created_at', { ascending: false })
    if (e) {
      setError(e.message)
      return
    }
    const list = (data ?? []) as Plan[]
    setPlans(list)
    setPlanId(select ?? list[0]?.id ?? '')
  }

  async function loadSceneLook() {
    const { data } = await insforge.database
      .from('scenes')
      .select('scene_number,location_name,key_light,screen_direction,staging,render_style')
      .eq('movie_id', movie.id)
      .order('scene_number', { ascending: true })
    setSceneLook((data ?? []) as SceneLook[])
  }

  /**
   * Stop now, not after this one.
   *
   * "Stop after this one" only sets the loop's flag, so it waits for the render
   * in flight - which is minutes. This also empties ComfyUI's queue and
   * interrupts whatever it is working on, so the GPU is free immediately. The
   * loop then sees the flag and stops rather than starting the next shot.
   */
  async function stopEverything() {
    stopRef.current = true
    const comfy = import.meta.env.VITE_COMFY_URL
    if (!comfy) {
      setError('Stopping after the current shot - VITE_COMFY_URL is not set, so the running job cannot be interrupted.')
      return
    }
    try {
      // The interrupt is the part that matters: the loop submits ONE render and
      // waits for it, so ComfyUI's queue is empty by definition and there is
      // never a backlog to clear. Clearing anyway costs nothing and covers a
      // queue filled from somewhere else.
      await fetch(`${comfy}/queue`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clear: true })
      })
      await fetch(`${comfy}/interrupt`, { method: 'POST' })
      setReviewNote('Stopped. The running render was interrupted and the next shot will not start.')
    } catch (e) {
      setError(`Could not reach ComfyUI to stop it: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  /**
   * Is this costume on by default, for a shot with these people in it?
   *
   * Only when its wearer owns exactly ONE costume. The moment a character has
   * two - the jacket in act one, the vest in act two - no default can choose
   * between them, and putting both on is worse than putting neither: nobody
   * wears two coats, and the render would be handed two contradicting
   * references. With more than one, the shot has to say.
   */
  function defaultWorn(pr: { kind: string; wornBy: string | null }, who: Set<string>) {
    if (pr.kind !== 'wardrobe' || !pr.wornBy || !who.has(pr.wornBy)) return false
    return propRefs.filter((o) => o.kind === 'wardrobe' && o.wornBy === pr.wornBy).length === 1
  }

  /**
   * Push a costume change back into the screenplay.
   *
   * The beats are what a redraft reads, so a change that lives only on the shot
   * is a change with a half-life of one draft. Each affected shot's beat gets
   * the costume recorded on the character it belongs to; an inserted shot with
   * no beat has nothing upstream to write to, and is skipped rather than
   * guessed at.
   *
   * Returns how many beats were touched, so the operator is told rather than
   * having the screenplay edited silently underneath them.
   */
  async function writeWardrobeUpstream(
    chosen: DirectorShot[],
    propId: string | null,
    on: boolean,
    wearer?: string
  ): Promise<number> {
    const beatIds = [...new Set(chosen.map((x) => x.beat_id).filter(Boolean))] as string[]
    if (!beatIds.length) return 0
    const label = propId ? (propRefs.find((pr) => pr.id === propId)?.label ?? null) : null
    const { data } = await insforge.database.from('beats').select('id,characters').in('id', beatIds)
    let touched = 0
    for (const b of (data ?? []) as { id: string; characters: Record<string, unknown>[] | null }[]) {
      const list = Array.isArray(b.characters) ? b.characters : []
      let changed = false
      const next = list.map((c) => {
        const nm = String(c.name ?? '').toUpperCase()
        // The screenplay writes "DR. EMMETT BROWN" where the cast list says
        // "BROWN", so the match is loose in both directions.
        const isWearer =
          wearer && (nm === wearer || nm.includes(wearer) || wearer.includes(nm))
        if (propId === null) {
          // "none" clears everyone; "default" leaves the script alone, because
          // the script IS the default.
          if (!on && c.wardrobe) {
            changed = true
            return { ...c, wardrobe: null }
          }
          return c
        }
        if (!isWearer) return c
        const want = on ? label : null
        if ((c.wardrobe ?? null) === want) return c
        changed = true
        return { ...c, wardrobe: want }
      })
      if (!changed) continue
      const { error: e } = await insforge.database.from('beats').update({ characters: next }).eq('id', b.id)
      if (!e) touched++
    }
    return touched
  }

  /**
   * Put a costume on a character ONCE, and keep the picture.
   *
   * The alternative is handing the shot render the person and the garment and
   * asking it to combine them - every shot, alongside a plate and two other
   * faces. That is where FLUX and Qwen start inventing. Done here it is one
   * render per (character, costume) pair, checkable before it is used, and the
   * costume cannot drift afterwards because it is part of the likeness.
   */
  /**
   * Put a costume on a character, once, and keep the picture.
   *
   * Hands the job to 40-Character-Wardrobe rather than composing the render
   * here. That flow renders a multi-view SHEET rather than one front-on picture
   * - which matters, because this stands in for the character's own reference
   * sheet, and a single front view would be a weaker reference than the thing it
   * replaces. It also names the garment from the costume's stored description
   * instead of saying "the garment in the second image", which came back as a
   * plain red shirt.
   *
   * And it versions the row. Inserting from here always wrote version 1, because
   * that is the column default - so a second costume for the same character hit
   * `character_images_character_kind_version_unique` and failed with a duplicate
   * key error.
   */
  async function makeDressed(name: string, propId: string) {
    const flowId = import.meta.env.VITE_CHARACTER_WARDROBE_ID
    if (!flowId) {
      setError('VITE_CHARACTER_WARDROBE_ID is not set in .env - restart the dev server after adding it.')
      return
    }
    const costume = propRefs.find((pr) => pr.id === propId)
    const { data: chars } = await insforge.database
      .from('characters')
      .select('id,name')
      .eq('movie_id', movie.id)
    const hit = ((chars ?? []) as { id: string; name: string }[]).find(
      (c) => c.name.toUpperCase() === name.toUpperCase()
    )
    if (!hit) {
      setError(`No character row called ${name}.`)
      return
    }
    setError(null)
    setStage('dressing')
    setProgress({ done: 0, total: 1, label: `${name} in ${costume?.label ?? 'the costume'}` })
    try {
      const res = parseFlowJson<{ action: string; imagePath?: string; basedOn?: string; error?: string; note?: string }>(
        await triggerFlow(flowId, { movieId: movie.id, characterId: hit.id, propId })
      )
      if (!res.ok || res.data.action !== 'dressed') {
        setError(res.ok ? (res.data.error ?? res.data.action) : res.message)
        return
      }
      await loadDressed()
      refreshData()
      setReviewNote(
        `${name} in ${costume?.label ?? 'the costume'} is ready` +
          (res.data.basedOn === 'qa_front' ? ' - built from a front-on QA shot, so the likeness is weaker than a full sheet' : '') +
          '. Shots where they wear it use that one picture now.'
      )
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setStage(null)
      setProgress(null)
    }
  }

  async function loadDressed() {
    const { data: chars } = await insforge.database.from('characters').select('id,name').eq('movie_id', movie.id)
    const list = (chars ?? []) as { id: string; name: string }[]
    if (!list.length) {
      setDressed([])
      return
    }
    const byId: Record<string, string> = {}
    for (const c of list) byId[c.id] = c.name.toUpperCase()
    const { data } = await insforge.database
      .from('character_images')
      .select('character_id,image_path,wardrobe_prop_id,version')
      .in('character_id', list.map((c) => c.id))
      .not('wardrobe_prop_id', 'is', null)
      // Oldest first, so the loop below leaves the NEWEST per pair in place - a
      // redo replaces rather than competes. Matters more now that rows can come
      // from two eras: the old inline insert wrote kind 'dressed', the flow
      // writes 'sheet', and both are found by the costume they carry.
      .order('version', { ascending: true })
    // Newest per pair wins, so a redo replaces rather than competes.
    const out: Record<string, Dressed> = {}
    for (const r of (data ?? []) as { character_id: string; image_path: string; wardrobe_prop_id: string }[]) {
      out[`${byId[r.character_id]}|${r.wardrobe_prop_id}`] = {
        character: byId[r.character_id],
        prop: r.wardrobe_prop_id,
        path: r.image_path
      }
    }
    setDressed(Object.values(out))
  }

  /**
   * Re-render the ticked shots.
   *
   * The other two render buttons answer different questions: the row's own
   * arrow is "this one", and "Redo N flagged" is "whatever the review
   * complained about". Neither is "the ones I just changed" - which is what you
   * want straight after setting a costume or a set on a handful of shots.
   */
  async function redoPicked() {
    const flowId = import.meta.env.VITE_IMAGE_EDIT_ID
    if (!flowId) {
      setError('VITE_IMAGE_EDIT_ID is not set in .env.')
      return
    }
    const todo = shots.filter((x) => picked.includes(x.id) && x.frame_prompt)
    if (!todo.length) {
      setError('None of the ticked shots has a prompt to render.')
      return
    }
    stopRef.current = false
    setError(null)
    // Dress the people and rewrite the prompts first, so what gets rendered is
    // the current wardrobe rather than the one these prompts were drafted with.
    const ready = await redress(todo)
    const edited = new Set(Object.keys(promptDraft))
    setStage('fixing')
    let done = 0
    const run = await pool(ready.shots, IN_FLIGHT, () => stopRef.current, async (x) => {
      // A prompt you typed yourself wins over the rebuilt one - it was a
      // deliberate edit. Everything else uses what the rewrite produced, not the
      // stale copy held in this component.
      const use = withFix(edited.has(x.id) ? promptDraft[x.id] : (x.frame_prompt ?? ''), x)
      const out = await renderOneFrame(x, use, flowId, ready.dressed)
      if ('error' in out) return { error: `Shot ${x.position}: ${out.error}` }
      done++
      setProgress({ done, total: ready.shots.length, label: `shot ${x.position}` })
    })
    if (run.error) setError(run.error)
    setStage(null)
    setProgress(null)
    await loadShots(planId)
    setReviewNote(
      `Re-rendered ${done} of ${todo.length} ticked shot(s)` + (ready.note ? ` - ${ready.note}` : '') + '.'
    )
  }

  /**
   * Dress one character across the ticked shots.
   *
   * One control per person rather than a costume picker and a wearer picker:
   * with those you could only say one pair at a time and could not see what
   * anyone had on, so a shot with two people in two costumes was a two-step
   * dance against invisible state.
   */
  async function dressCharacter(name: string, propId: string | null) {
    // Was a bare `return`, which meant choosing a costume with nothing ticked
    // did nothing AND said nothing - the dropdown showed the new value while the
    // database kept the old one, so it looked applied and was not.
    if (!picked.length) {
      setError('Nothing is ticked, so there are no shots to dress. Tick the shots first.')
      return
    }
    setError(null)
    const chosen = shots.filter((x) => picked.includes(x.id))
    if (!chosen.length) {
      setError('The ticked shots are no longer in this plan - untick and try again.')
      return
    }
    for (const x of chosen) {
      // Everyone else keeps what they had; only this person changes.
      const others = wornIn(x).filter((w) => w.on !== name)
      const next = propId ? [...others, { prop: propId, on: name }] : others
      const { error: e } = await insforge.database.from('director_shots').update({ wardrobe: next }).eq('id', x.id)
      if (e) {
        setError(e.message)
        return
      }
    }
    const upstream = await writeWardrobeUpstream(chosen, propId, propId !== null, name)
    await loadShots(planId)
    const label = propId ? propRefs.find((pr) => pr.id === propId)?.label : null

    // Rewrite the prompts of exactly these shots.
    //
    // A prompt is baked at draft time, so putting a vest on a character leaves every
    // one of them still saying "long-buttoned denim shirt worn over a white
    // t-shirt" - and the words beat the picture often enough to ruin the shot.
    // Scoped to the ticked positions: a costume assigned in one scene has
    // nothing to say about the rest of the film.
    const flowId = import.meta.env.VITE_DIRECTOR_ID
    let reworded = 0
    if (flowId) {
      const rb = parseFlowJson<{ action: string; changed?: number }>(
        await triggerFlow(flowId, {
          movieId: movie.id,
          planId: plan?.id,
          mode: 'rebind',
          positions: chosen.map((x) => x.position)
        })
      )
      if (rb.ok && rb.data.action === 'rebound') reworded = rb.data.changed ?? 0
    }
    await loadShots(planId)

    // Make the dressed picture now, without being asked.
    //
    // It is needed by every shot this pair appears in, and leaving it behind a
    // button meant the costume went on and the render still got the person and
    // the garment separately - the squirrelly path this was built to avoid.
    // Once per pair, never again: if one exists this does nothing.
    if (propId && !dressed.some((d) => d.character === name && d.prop === propId)) {
      await makeDressed(name, propId)
      return
    }
    // Said plainly, because "it did not get applied" is indistinguishable from
    // "it did" when nothing reports either way.
    setReviewNote(
      `${name} ${label ? `is wearing ${label}` : 'is in their ordinary clothes'} in ${chosen.length} shot(s)` +
        (upstream ? `, written into ${upstream} beat(s)` : '') +
        (reworded ? `, ${reworded} prompt(s) reworded` : '') +
        '. Redo their frames to see it.'
    )
  }

  /** Shot states that a re-render can actually put right. */
  const REDOABLE = ['redo_frame', 'redo_prev', 'redo_next']

  /**
   * The prompt, plus whatever the review worked out was wrong with this shot.
   *
   * The correction goes LAST, so it is the final thing the renderer reads.
   *
   * Without this, Redo on a flagged shot sent the same request again and returned
   * the same picture, which reads as a broken button - the complaint survived and
   * the repair never happened. Only "Redo N flagged" was applying the constraint,
   * so the same word meant two different things depending on which button you
   * reached for. It means one thing now: render this again, and fix what we know
   * is wrong with it.
   */
  function withFix(prompt: string, s: DirectorShot) {
    if (!s.review_constraint || !REDOABLE.includes(s.review_state ?? '')) return prompt
    return [prompt, s.review_constraint].filter(Boolean).join(' ')
  }

  /**
   * Everything that has to happen BEFORE a frame is rendered, in order.
   *
   *   1. dress the people    - one picture per person, already in the costume
   *   2. rewrite the prompt  - rebuilt from the script and today's wardrobe
   *   3. hand both to the render
   *
   * This is what Redo means. It used to mean step 3 on its own, so a costume
   * chosen in the tab moved a reference picture and left the words describing the
   * old outfit - and the words win that argument often enough to ruin the shot.
   * Pressing Redo twice did not help, because nothing in the loop ever rewrote
   * anything.
   *
   * Fresh rows and a fresh dressed list are RETURNED rather than read back off
   * state: loadShots() and loadDressed() do not land until the next render, and
   * the render is about to happen in this same function call.
   */
  async function redress(targets: DirectorShot[]) {
    const fresh = { shots: targets, dressed, note: '' }
    if (!targets.length) return fresh
    const notes: string[] = []

    // 1. A picture of each person already wearing what they were given. Made
    //    once per pair, never again - if one exists this does nothing.
    const wardrobeFlow = import.meta.env.VITE_CHARACTER_WARDROBE_ID
    const pairs: { on: string; prop: string }[] = []
    for (const x of targets) {
      for (const w of wornIn(x)) {
        if (pairs.some((p) => p.on === w.on && p.prop === w.prop)) continue
        if (dressed.some((d) => d.character === w.on && d.prop === w.prop)) continue
        pairs.push(w)
      }
    }
    if (pairs.length && wardrobeFlow) {
      const { data: chars } = await insforge.database.from('characters').select('id,name').eq('movie_id', movie.id)
      const cast = (chars ?? []) as { id: string; name: string }[]
      setStage('dressing')
      let n = 0
      for (const p of pairs) {
        const hit = cast.find((c) => c.name.toUpperCase() === p.on)
        if (!hit) continue
        const label = propRefs.find((pr) => pr.id === p.prop)?.label ?? 'the costume'
        setProgress({ done: n, total: pairs.length, label: `${p.on} in ${label}` })
        const res = parseFlowJson<{ action: string; error?: string }>(
          await triggerFlow(wardrobeFlow, { movieId: movie.id, characterId: hit.id, propId: p.prop })
        )
        if (res.ok && res.data.action === 'dressed') n++
        else notes.push(`${p.on} could not be dressed in ${label}`)
      }
      setProgress(null)
      setStage(null)
      if (n) notes.push(`${n} dressed picture(s) made`)
    }

    // 2. The prompts, rebuilt from the script's own words and today's wardrobe.
    //    Scoped to these shots only: a costume worn in one scene has nothing to
    //    say about the rest of the film, and a shot with only a character in it must
    //    not hear about BROWN's coat.
    const directorFlow = import.meta.env.VITE_DIRECTOR_ID
    if (directorFlow && plan?.id) {
      const rb = parseFlowJson<{ action: string; changed?: number; missed?: string[] }>(
        await triggerFlow(directorFlow, {
          movieId: movie.id,
          planId: plan.id,
          mode: 'rebind',
          positions: targets.map((x) => x.position)
        })
      )
      if (rb.ok && rb.data.action === 'rebound') {
        if (rb.data.changed) notes.push(`${rb.data.changed} prompt(s) rewritten`)
        for (const m of rb.data.missed ?? []) notes.push(m)
      } else if (!rb.ok) {
        notes.push(`the prompts could not be rewritten - ${rb.message}`)
      }
    }

    // 3. Read back what those two steps actually produced.
    const { data: rows } = await insforge.database
      .from('director_shots')
      .select('*')
      .in('id', targets.map((x) => x.id))
    const byId: Record<string, DirectorShot> = {}
    for (const r of (rows ?? []) as DirectorShot[]) byId[r.id] = r
    const { data: chars2 } = await insforge.database.from('characters').select('id,name').eq('movie_id', movie.id)
    const list2 = (chars2 ?? []) as { id: string; name: string }[]
    const nameOf: Record<string, string> = {}
    for (const c of list2) nameOf[c.id] = c.name.toUpperCase()
    const { data: imgs } = list2.length
      ? await insforge.database
          .from('character_images')
          .select('character_id,image_path,wardrobe_prop_id,version')
          .in('character_id', list2.map((c) => c.id))
          .not('wardrobe_prop_id', 'is', null)
          .order('version', { ascending: true })
      : { data: [] }
    const latest: Record<string, Dressed> = {}
    for (const r of (imgs ?? []) as { character_id: string; image_path: string; wardrobe_prop_id: string }[]) {
      latest[`${nameOf[r.character_id]}|${r.wardrobe_prop_id}`] = {
        character: nameOf[r.character_id],
        prop: r.wardrobe_prop_id,
        path: r.image_path
      }
    }
    const nowDressed = Object.values(latest)
    setDressed(nowDressed)
    return {
      shots: targets.map((x) => byId[x.id] ?? x),
      dressed: nowDressed,
      note: notes.join(', ')
    }
  }

  /**
   * Who was put into what ELSEWHERE IN THIS SCENE.
   *
   * A costume assigned to someone holds for the scene, which is the rule the
   * Director node rewrites prompts by. This side did not know that rule, so it
   * kept sending the plain reference sheet for every shot that had not been
   * literally ticked: the words said puffer vest and the picture said denim
   * shirt, on the same render, and the picture usually won. Both sides read it
   * the same way now - first shot of the scene that says so wins, so a change of
   * clothes later in the same scene still needs its own shots ticked.
   */
  function sceneChoiceFor(scene: number | null) {
    const out: Record<string, string> = {}
    for (const x of shots) {
      if (x.scene_number !== scene) continue
      const live = x.wardrobe?.filter((w) => propRefs.some((pr) => pr.id === w.prop)) ?? []
      for (const w of live) {
        const on = w.on.toUpperCase()
        if (!out[on]) out[on] = w.prop
      }
    }
    return out
  }

  /** What this shot's people are actually wearing, pairs either way. */
  function wornIn(x: DirectorShot): { prop: string; on: string }[] {
    // A pair whose costume has been deleted is dropped, not obeyed. The column
    // is jsonb with no foreign key, so a deleted costume leaves the pair behind,
    // and reading it literally undressed people whose outfit had been replaced.
    // An empty array is a deliberate "nobody", and stays one.
    const live = x.wardrobe?.filter((w) => propRefs.some((pr) => pr.id === w.prop)) ?? null
    if (live && (live.length > 0 || x.wardrobe?.length === 0)) return live
    const here = (x.characters ?? []).map((c) => c.toUpperCase())
    const mine = sceneChoiceFor(x.scene_number)
    const pairs: { prop: string; on: string }[] = []
    for (const n of here) {
      const hit = Object.keys(mine).find((k) => k === n || n.includes(k) || k.includes(n))
      if (hit) pairs.push({ prop: mine[hit], on: n })
    }
    // Then the costume's own wearer, for anyone the scene said nothing about.
    const who = new Set(here.filter((n) => !pairs.some((p) => p.on === n)))
    for (const pr of propRefs.filter((p) => defaultWorn(p, who))) {
      pairs.push({ prop: pr.id, on: pr.wornBy as string })
    }
    return pairs
  }

  /**
   * What the ticked shots' characters are wearing.
   *
   * Per shot because a costume comes off mid-act: the suit is on through shot 10
   * and gone from 11. The alternative was a second character with its own
   * reference set for the same person, which is a costume change modelled as a
   * different human being.
   *
   * `null` on a shot means "whatever the costume's own wearer says", so a film
   * where nobody changes never has to touch this.
   */
  async function setShotWardrobe(propId: string | null, on: boolean, wearer?: string) {
    if (!picked.length) {
      setError('Tick the shots first - a costume change applies to the ones you choose.')
      return
    }
    setError(null)
    const chosen = shots.filter((x) => picked.includes(x.id))
    for (const x of chosen) {
      let next: { prop: string; on: string }[] | null
      if (propId === null) {
        // Back to the default, or nobody wearing anything.
        next = on ? null : []
      } else {
        // Starting from what the shot is wearing now - the default included -
        // so taking one costume off does not silently strip the others.
        const now = wornIn(x)
        if (on) {
          if (!wearer) {
            setError('Say who is wearing it - a costume with nobody in it tells the render nothing.')
            return
          }
          // One costume per person per shot: putting a second on someone
          // replaces the first, because nobody wears two coats.
          next = [...now.filter((w) => w.on !== wearer && w.prop !== propId), { prop: propId, on: wearer }]
        } else {
          // Off for the named person, or off everyone if none was named.
          next = now.filter((w) => w.prop !== propId || (wearer ? w.on !== wearer : false))
        }
      }
      const { error: e } = await insforge.database.from('director_shots').update({ wardrobe: next }).eq('id', x.id)
      if (e) {
        setError(e.message)
        return
      }
    }
    // Upstream, so a redraft keeps it.
    //
    // A shot list is rebuilt from the beats. Without this, putting a vest on
    // a character in shot 12 lasts exactly until the next draft, which reads a
    // screenplay that never mentioned a vest and quietly takes it off again.
    // Written onto the beat's own character entry, beside their blocking and
    // presence, which is where the script says what a person is like in a beat.
    const upstream = await writeWardrobeUpstream(chosen, propId, on, wearer)

    await loadShots(planId)
    setReviewNote(
      propId === null
        ? on
          ? `${chosen.length} shot(s) back to the default costumes.`
          : `${chosen.length} shot(s) now wear no costumes at all.`
        : `Costume ${on ? 'put on in' : 'taken off in'} ${chosen.length} shot(s)` +
          (upstream ? `, and written into ${upstream} beat(s) so a redraft keeps it` : '') +
          '. Redo their frames to see it.'
    )
  }

  /**
   * Put one background behind several shots.
   *
   * Nothing is re-rendered here - it only says which plate each shot belongs on.
   * The picture changes on the next redo, which keeps a bulk action from
   * spending GPU on shots you were only pinning.
   */
  async function applyPlate(path: string | null) {
    if (!picked.length) {
      setError('Tick the shots first - the plate is applied to the ones you choose.')
      return
    }
    setError(null)
    const { error: e } = await insforge.database
      .from('director_shots')
      .update({ plate_path: path })
      .in('id', picked)
    if (e) {
      setError(e.message)
      return
    }
    await loadShots(planId)
    setReviewNote(
      path
        ? `${picked.length} shot(s) placed on that background. Redo their frames to see it.`
        : `Background cleared on ${picked.length} shot(s).`
    )
  }

  /** One field on one scene. Written straight through - no render, no flow. */
  async function patchScene(scene: number, change: Partial<SceneLook>) {
    const { error: e } = await insforge.database
      .from('scenes')
      .update(change)
      .eq('movie_id', movie.id)
      .eq('scene_number', scene)
    if (e) setError(e.message)
    await loadSceneLook()
  }

  async function loadShots(id: string) {
    if (!id) {
      setShots([])
      return
    }
    const { data, error: e } = await insforge.database
      .from('director_shots')
      .select('*')
      .eq('plan_id', id)
      .order('position', { ascending: true })
    if (e) setError(e.message)
    else setShots((data ?? []) as DirectorShot[])
  }

  useEffect(() => {
    setDryRun(null)
    setError(null)
    loadPlans()
    loadSceneLook()
    loadDressed()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [movie.id, dataVersion])

  useEffect(() => {
    loadShots(planId)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [planId])

  // The runtime box follows the selected plan, and drafting sends whatever the
  // box says - so a plan's runtime is changed in place instead of having to
  // make a new plan for it. (It used to feed only "New plan", so typing 240 and
  // pressing Draft silently redrafted the same plan at 120.)
  useEffect(() => {
    const p = plans.find((x) => x.id === planId)
    if (p) setTargetSeconds(p.target_seconds)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [planId])

  async function handleNewPlan() {
    setBusy(true)
    setError(null)
    const { data, error: e } = await insforge.database
      .from('director_plans')
      .insert([{ movie_id: movie.id, target_seconds: targetSeconds }])
      .select()
    setBusy(false)
    if (e) {
      setError(e.message)
      return
    }
    await loadPlans(((data ?? []) as Plan[])[0]?.id)
  }

  /** Asks the director flow what it would plan from. Writes nothing yet. */
  async function handleDryRun() {
    const flowId = import.meta.env.VITE_DIRECTOR_ID
    if (!flowId) {
      setError('VITE_DIRECTOR_ID is not set in .env.')
      return
    }
    setBusy(true)
    setError(null)
    // try/finally, because this flag gates the Draft button: when a call hung on
    // an unresponsive LLM the await never returned, busy stayed true, and Draft
    // was disabled for the life of the tab with nothing on screen saying why.
    try {
      const res = parseFlowJson<DryRun>(
        await triggerFlow(flowId, { movieId: movie.id, planId: planId || null, targetSeconds })
      )
      if (!res.ok) setError(res.message)
      else setDryRun(res.data)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  /**
   * The planning pass: the director flow drafts the shot list for this plan
   * with the LLM, enforces DIRECTOR.md's rules, writes it, and stops. Nothing
   * is generated - the list is for review.
   */
  async function handleDraft() {
    const flowId = import.meta.env.VITE_DIRECTOR_ID
    // Never return silently: this used to do nothing at all when the id was
    // missing, so clicking Draft looked like a dead button. Vite reads .env only
    // at startup, so a dev server older than the variable has it as undefined
    // however many times the model box is restarted.
    if (!flowId) {
      setError('VITE_DIRECTOR_ID is undefined in the browser. Restart the Vite dev server (npm run dev) - it only reads .env at startup.')
      return
    }
    if (!plan) {
      setError('No plan is selected. Press New plan first.')
      return
    }
    setDrafting(true)
    setError(null)
    setPlanResult(null)
    let res
    try {
      res = parseFlowJson<PlanResult>(
        await triggerFlow(flowId, { movieId: movie.id, planId: plan.id, targetSeconds, mode: 'plan' })
      )
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      return
    } finally {
      // Always clears, so a failed draft never leaves the button stuck.
      setDrafting(false)
    }
    if (!res.ok) {
      setError(res.message)
      return
    }
    setPlanResult(res.data)
    await loadPlans(plan.id)
    await loadShots(plan.id)
  }

  // ------------------------------------------------ stage 1: first frames
  const [charRefs, setCharRefs] = useState<Record<string, CharRef[]>>({})
  // Props and costumes that have a sheet, with every word the script calls them
  // by. These were only ever used in the Context Loop render - a FIRST frame got
  // the prop as words alone, which is why the a vehicle was whatever the model
  // felt like drawing.
  // Pre-dressed references, by character and costume. Generated once per pair,
  // used in every shot that pair appears in.
  const [dressed, setDressed] = useState<Dressed[]>([])
  const [propRefs, setPropRefs] = useState<
    { id: string; kind: string; names: string[]; path: string; label: string; wornBy: string | null }[]
  >([])
  const [stage, setStage] = useState<string | null>(null)
  // Which shots a single press does, by the # in the shot list. 0 means open at
  // that end, so 0–0 is everything. Rendering 26 shots is an hour and a half, so
  // being able to run 2–4 and look is the difference between finding a problem
  // in eight minutes and finding it in ninety.
  const [fromPos, setFromPos] = useState(0)
  const [toPos, setToPos] = useState(0)
  const inRange = (position: number) =>
    (fromPos === 0 || position >= fromPos) && (toPos === 0 || position <= toPos)
  const rangeNote = fromPos === 0 && toPos === 0 ? 'all shots' : `shots ${fromPos || 1} to ${toPos || 'the end'}`
  const [progress, setProgress] = useState<{ done: number; total: number; label: string } | null>(null)
  const stopRef = useRef(false)

  // Each character's reference images, newest version of each kind.
  useEffect(() => {
    let live = true
    ;(async () => {
      // Props and costumes with a sheet, matched later against what each shot
      // says. Aliases included because a prop is almost never called one thing.
      const { data: props } = await insforge.database
        .from('movie_props')
        .select('id,kind,name,aliases,image_path,worn_by')
        .eq('movie_id', movie.id)
        .not('image_path', 'is', null)
      if (live) {
        setPropRefs(
          (
            (props ?? []) as {
              id: string
              kind: string
              name: string
              aliases: string[] | null
              image_path: string
              worn_by: string | null
            }[]
          ).map((pr) => ({
            id: pr.id,
            kind: pr.kind,
            names: [pr.name, ...(pr.aliases ?? [])].map((x) => String(x).trim().toLowerCase()).filter(Boolean),
            path: pr.image_path,
            label: pr.name,
            wornBy: pr.worn_by ? pr.worn_by.toUpperCase() : null
          }))
        )
      }
      const { data: chars } = await insforge.database.from('characters').select('id,name').eq('movie_id', movie.id)
      const list = (chars ?? []) as { id: string; name: string }[]
      if (list.length === 0) {
        if (live) setCharRefs({})
        return
      }
      const { data: imgs } = await insforge.database
        .from('character_images')
        .select('character_id,kind,version,image_path')
        .filter('character_id', 'in', `(${list.map((c) => c.id).join(',')})`)
        .order('version', { ascending: true })
      const rows = (imgs ?? []) as { character_id: string; kind: string; version: number; image_path: string }[]
      const out: Record<string, CharRef[]> = {}
      for (const c of list) {
        const mine = rows.filter((r) => r.character_id === c.id)
        // Ascending by version, so the last row of a kind is the newest one.
        const newest = (kind: string) => mine.filter((r) => r.kind === kind).slice(-1)[0]
        // ANY usable reference, best first - not just the two preferred kinds.
        //
        // This took 'sheet' and 'qa_front' and nothing else, so a character whose
        // references came out as fbody/portrait/turnaround/uppertorso had FOUR
        // good pictures and was treated as having none: dropped from every shot,
        // rendered from the words alone.
        //
        // And dropping one is worse than it sounds. The prompt addresses
        // references by position - "the character from the second image" - so a
        // missing person shifts everyone after them by one, and the descriptions
        // land on the wrong pictures. One character with the wrong KIND of
        // reference quietly breaks every shot they appear in.
        const best = ['sheet', 'qa_front', 'fbody', 'uppertorso', 'portrait', 'turnaround']
          .map(newest)
          .filter(Boolean)
        // The fallbacks are a last resort, not extra references: one picture per
        // person is what the prompt's ordinals are counted against.
        const picked = newest('sheet') && newest('qa_front') ? [newest('sheet'), newest('qa_front')] : best.slice(0, 1)
        out[c.name.toUpperCase()] = picked
          .filter(Boolean)
          .map((r) => ({ path: r.image_path, label: `${c.name} ${r.kind}` }))
      }
      if (live) setCharRefs(out)
    })()
    return () => {
      live = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [movie.id, dataVersion])

  // A frame being re-rendered on its own, and any edits made to its prompt
  // before that. Kept per shot so several cards can be edited before any is run.
  const [redoing, setRedoing] = useState<string | null>(null)
  const [promptDraft, setPromptDraft] = useState<Record<string, string>>({})
  // The motion prompt, edited in place. It is what the video model is given -
  // the frame prompt only decides the first picture - so a clip that moves
  // wrongly is fixed here, not there. Held as a draft rather than written on
  // every keystroke, and saved when the clip is rendered.
  const [motionDraft, setMotionDraft] = useState<Record<string, string>>({})

  // Every picture in the movie, for swapping one in as a shot's first frame.
  // Relit and graded versions land in these same groups, so a pass through the
  // Relight or Colour tab shows up here without anything extra.
  const [sources, setSources] = useState<ImageSource[]>([])
  const pickerGroups = toPickerGroups(sources)
  useEffect(() => {
    loadImageSources(movie.id).then(setSources)
  }, [movie.id, dataVersion])

  /**
   * Swap an existing picture in as this shot's first frame.
   *
   * No render: `director_shots.first_frame_path` and the picker both address
   * pictures by ComfyUI path, so this is one database write. Approval is cleared
   * because the frame is not the one that was approved.
   */
  async function substituteFrame(s: DirectorShot, sourceId: string) {
    const picked = sources.find((x) => x.id === sourceId)
    if (!picked) return
    setError(null)
    const { error: e } = await insforge.database
      .from('director_shots')
      .update({ first_frame_path: picked.path, status: 'framed', frame_approved: false })
      .eq('id', s.id)
    if (e) setError(`Shot #${s.position}: ${e.message}`)
    await loadShots(planId)
  }

  /** One shot's first frame. Shared so a redo takes exactly the batch's path. */
  // `dressedIn` is the list redress() just produced. State is a render behind at
  // this point, so a sheet made moments ago would not be found and the render
  // would fall back to the person's plain picture - the costume on the reference
  // and not in the frame.
  async function renderOneFrame(s: DirectorShot, promptIn: string, flowId: string, dressedIn?: Dressed[]) {
    const dressedNow = dressedIn ?? dressed
    const prompt = promptIn
    // Four reference pictures, shared out in order of what words cannot do.
    //
    //   1. the plate      - words never hold a LOCATION still
    //   2. the props      - words never hold an OBJECT still, which is the whole
    //                       reason sheets exist. These were missing here: a
    //                       first frame got the a vehicle as a sentence, so it
    //                       came back as whatever car the model preferred.
    //   3. the cast       - faces, as many as the rest allows
    //
    // Props before cast because a face has a written anchor that works
    // reasonably well, and an object does not.
    const plate = s.plate_path ? [{ path: s.plate_path, label: 'the location' }] : []
    const said = `${s.frame_prompt ?? ''} ${s.notes ?? ''}`.toLowerCase()
    // Anyone with a pre-dressed picture needs neither their plain sheet nor the
    // costume's - one reference does both, which is the whole point of making
    // them. The costume is then dropped from the shot's references entirely.
    const wornHere = wornIn(s)
    const dressedHere = wornHere
      .map((w) => dressedNow.find((d) => d.character === w.on && d.prop === w.prop))
      .filter(Boolean) as Dressed[]
    const coveredCostumes = new Set(dressedHere.map((d) => d.prop))

    const props = propRefs
      .filter((pr) => {
        if (coveredCostumes.has(pr.id)) return false
        // A costume is decided by the SHOT when the shot says so - that is what
        // lets someone take it off mid-scene. Only when the shot is silent does
        // the costume's own wearer apply.
        if (pr.kind === 'wardrobe') return wornIn(s).some((w) => w.prop === pr.id)
        // A prop is named when it appears, so it matches on its words.
        return pr.names.some((nme) => said.includes(nme))
      })
      .slice(0, 2)
      .map((pr) => ({ path: pr.path, label: pr.label }))
    // ORDER MATTERS, and it is not free to choose.
    //
    // The prompt names references by position - "the character from the first
    // image, a character", "the man from the third image is BROWN" - written at draft
    // time when the references were the cast in the order the prompt mentions
    // them. Putting the plate in slot one shifted every one of those by one, so
    // a character's likeness was being taken from a photograph of a car park. The
    // outfit could not change because nothing was pointing at him.
    //
    // So the people come first, in the order the shot lists them, each as one
    // picture - dressed where there is one, plain otherwise - and the plate goes
    // last where no ordinal refers to it.
    const order = (s.characters ?? []).map((c) => c.toUpperCase())
    const people: { path: string; label: string }[] = []
    for (const name of order) {
      const dressedOne = dressedHere.find((d) => d.character === name)
      if (dressedOne) {
        people.push({ path: dressedOne.path, label: `${name}, dressed` })
        continue
      }
      const own = (charRefs[name] ?? [])[0]
      if (own) people.push({ path: own.path, label: name })
    }
    // People are never dropped to make room for a prop or a plate. Truncating
    // them leaves the prompt still saying "the man from the third image is
    // BROWN" with a prop sitting in slot three - the same misalignment, one step
    // further along. The extras take what is left, in that order.
    const cast = people.slice(0, 4)
    const left = 4 - cast.length
    const propRefsUsed = props.slice(0, Math.max(0, left))
    const plateUsed = plate.slice(0, Math.max(0, left - propRefsUsed.length))
    // NOTHING about clothes is added here, and nothing is cut out of the prompt.
    //
    // This used to strip "X is wearing ..." with a regex and append its own
    // version, because the prompt was baked at draft time and could not be
    // reached any other way. That is what made prompts grow: the costume arrived
    // in the person's description, again in the reference note, and again in a
    // sentence tacked on here, and a clause that did not match the pattern was
    // never removed - one prompt ended up carrying the same trench coat six
    // times. The prompt is now REBUILT from the script before every redo
    // (redress), so by the time it arrives here it already says exactly what
    // these people are wearing, once. Editing it again can only undo that.
    const notes: string[] = []
    if (plateUsed.length) {
      // Deliberately not "do not redraw it": that told the model to keep
      // everything in the plate, including a car that happened to be parked in
      // it, and the shot's own vehicle vanished.
      notes.push(
        'The place is exactly as in the reference image of the location - same architecture, signage, ground and angle. Keep the setting; the people and objects described above are placed into it.'
      )
    }
    if (propRefsUsed.length) {
      notes.push(
        `${propRefsUsed.map((pr) => pr.label).join(' and ')} must match ${propRefsUsed.length > 1 ? 'their' : 'its'} reference picture exactly.`
      )
    }
    const withPlate = notes.length ? `${prompt} ${notes.join(' ')}` : prompt
    const res = parseFlowJson<{ outputPath: string }>(
      await triggerFlow(flowId, {
        movieId: movie.id,
        prompt: withPlate,
        // People first so the prompt's ordinals line up; the plate last.
        references: [...cast, ...propRefsUsed, ...plateUsed],
        width: FRAME_W,
        height: FRAME_H,
        steps: 8
      })
    )
    if (!res.ok) return { error: res.message }
    if (!res.data.outputPath) return { error: 'The render returned no image path.' }
    // Checked, because this is the step that makes a render COUNT. It was
    // fire-and-forget: a shot re-rendered correctly, with the right references,
    // and then kept pointing at the picture from hours earlier - the GPU time
    // was spent and the result thrown away, silently.
    const { error: wrote } = await insforge.database
      .from('director_shots')
      .update({ first_frame_path: res.data.outputPath, status: 'framed', frame_approved: false })
      .eq('id', s.id)
    if (wrote) {
      return { error: `Shot ${s.position} rendered (${res.data.outputPath}) but the shot could not be updated: ${wrote.message}` }
    }
    // A new picture exists on disk. Everything that lists pictures - the swap-in
    // picker, the cast references, the props - is told to look again, so the tab
    // shows the render that just landed instead of what was there when it
    // mounted. This is the only line every render path goes through, which is
    // why it is here rather than at the end of each of them.
    refreshData()
    return { path: res.data.outputPath }
  }

  /**
   * Re-render one frame in place. The shot keeps its position, so the new
   * picture replaces the old one in the gallery rather than arriving at the end.
   * An edited prompt is saved to the shot first, so the change sticks and the
   * next redo starts from it.
   */
  async function redoFrame(s: DirectorShot) {
    const flowId = import.meta.env.VITE_IMAGE_EDIT_ID
    if (!flowId) {
      setError('VITE_IMAGE_EDIT_ID is not set in .env.')
      return
    }
    const edited = promptDraft[s.id]
    setRedoing(s.id)
    setError(null)
    // A prompt typed by hand is saved and then used as written - it was a
    // deliberate edit and nothing should rewrite it.
    if (edited !== undefined && edited !== s.frame_prompt) {
      const { error: saved } = await insforge.database
        .from('director_shots')
        .update({ frame_prompt: edited })
        .eq('id', s.id)
      if (saved) {
        setError(`Shot ${s.position}: the edited prompt could not be saved - ${saved.message}`)
        setRedoing(null)
        return
      }
    }
    // Otherwise: dress the people, rewrite the prompt from the script and
    // today's wardrobe, and render THAT. This is the order the button promises.
    const ready = edited !== undefined ? { shots: [s], dressed, note: '' } : await redress([s])
    const use = withFix(edited !== undefined ? edited : (ready.shots[0]?.frame_prompt ?? ''), ready.shots[0] ?? s)
    if (!use.trim()) {
      setError(`Shot #${s.position} has no prompt to render.`)
      setRedoing(null)
      return
    }
    const res = await renderOneFrame(ready.shots[0] ?? s, use, flowId, ready.dressed)
    setRedoing(null)
    if ('error' in res) setError(`Shot #${s.position}: ${res.error}`)
    else if (ready.note) setReviewNote(`Shot #${s.position}: ${ready.note}.`)
    await loadShots(planId)
  }

  /**
   * One Image Edit call per shot, driven from here rather than inside the flow.
   * Twenty-five shots is the better part of an hour, which no single Flowise
   * request should hold open, and going a shot at a time means a ComfyUI
   * restart costs one frame instead of the batch. Shots that already have a
   * frame are skipped, so pressing the button again resumes where it stopped.
   */
  async function runFrames() {
    const flowId = import.meta.env.VITE_IMAGE_EDIT_ID
    if (!flowId) {
      setError('VITE_IMAGE_EDIT_ID is not set in .env.')
      return
    }
    const remaining = shots.filter((s) => !s.first_frame_path)
    if (remaining.length === 0) {
      setError('Every shot already has a first frame.')
      return
    }
    const todo = remaining.filter((s) => inRange(s.position))
    if (todo.length === 0) {
      setError(`Nothing left to do in ${rangeNote}.`)
      return
    }
    stopRef.current = false
    setError(null)
    setStage('frames')
    let done = 0
    // Several in flight, so ComfyUI's queue is never empty between shots.
    const run = await pool(todo, IN_FLIGHT, () => stopRef.current, async (s) => {
      const res = await renderOneFrame(s, s.frame_prompt ?? '', flowId)
      if ('error' in res) {
        // Result ignored on purpose: the real failure is already being
        // reported, and a second error about the status write would bury it.
        await insforge.database.from('director_shots').update({ status: 'failed' }).eq('id', s.id)
        return { error: `Shot #${s.position}: ${res.error}` }
      }
      done++
      setProgress({ done, total: todo.length, label: `shot #${s.position}` })
      await loadShots(planId) // the list fills in as they land
    })
    if (run.error) setError(run.error)
    setStage(null)
    setProgress(null)
    await loadShots(planId)
  }

  /**
   * Stage 3 - clips. One MiniMax render per shot, driven from here for the same
   * reasons as the frames: 26 shots is well over an hour, and a shot at a time
   * means a ComfyUI stop costs one clip rather than the run.
   *
   * A shot marked `continue` goes through the **Extend** flow instead of Image
   * to Video: it carries the previous clip's last 22 frames AND the matching
   * audio into the new one (DIRECTOR.md 7b), so the join keeps both the motion
   * and the soundtrack. Every other shot starts from its own first frame, which
   * restarts the sound - correct for a cut, wrong for a continuation.
   */
  /**
   * Render the clip for ONE shot.
   *
   * Lifted out of the Clips stage rather than written again beside it: staging
   * the first frame, the clip row, the choice between i2v and extend and the
   * status writes are all particular, and two copies would drift the first time
   * any of them changed.
   *
   * Failures are returned rather than announced, so a batch can stop the run and
   * a single render can report against its own row.
   */
  async function renderClipFor(
    s: DirectorShot,
    prevClip: string | null
  ): Promise<{ clipId: string } | { error: string }> {
    const i2vId = import.meta.env.VITE_MINIMAX_I2V_ID
    const extendId = import.meta.env.VITE_MINIMAX_EXTEND_ID
    if (!i2vId || !extendId) {
      return { error: 'VITE_MINIMAX_I2V_ID / VITE_MINIMAX_EXTEND_ID are not set in .env.' }
    }
      const guided = s.continuity === 'continue' && !!prevClip

      let firstKey: string | null = null
      if (!guided) {
        if (!s.first_frame_path) {
          return { error: `Shot #${s.position} has no first frame yet - run First frames before Clips.` }
        }
        // The frame lives in ComfyUI's output folder, but minimax_clips wants an
        // InsForge storage KEY: the flow stages that key into ComfyUI's input/
        // folder itself before LoadImage can read it. So the bytes come back out
        // of ComfyUI and go up to the movie's bucket.
        let key: string
        try {
          const res = await fetch(comfyViewUrl(s.first_frame_path))
          if (!res.ok) throw new Error(`ComfyUI returned HTTP ${res.status}`)
          const blob = await res.blob()
          const up = await uploadToMovie(
            movie,
            'director',
            new File([blob], `shot_${s.position}_first.png`, { type: 'image/png' })
          )
          if ('error' in up) throw new Error(up.error)
          key = up.key
        } catch (e) {
          return { error: `Shot #${s.position}: could not stage its first frame - ${e instanceof Error ? e.message : String(e)}` }
        }
        firstKey = key
      }

      const { data: inserted, error: insErr } = await insforge.database
        .from('minimax_clips')
        .insert([
          {
            movie_id: movie.id,
            beat_id: s.beat_id,
            mode: guided ? 'extend' : 'i2v_first',
            prompt: s.motion_prompt ?? '',
            first_image_path: firstKey,
            source_clip_id: guided ? prevClip : null,
            width: FRAME_W,
            height: FRAME_H,
            length: s.length_frames,
            use_spectrum: useSpectrum,
            status: 'queued'
          }
        ])
        .select()
      if (insErr) {
        return { error: `Shot #${s.position}: ${insErr.message}` }
      }
      // The SDK does not reliably echo the inserted row back - the same fallback
      // the MiniMax tab uses.
      let clipId = ((inserted ?? []) as { id: string }[])[0]?.id
      if (!clipId) {
        const { data: recent } = await insforge.database
          .from('minimax_clips')
          .select('id')
          .eq('movie_id', movie.id)
          .order('created_at', { ascending: false })
          .limit(1)
        clipId = ((recent ?? []) as { id: string }[])[0]?.id
      }
      if (!clipId) {
        return { error: `Shot #${s.position}: the clip row could not be read back after inserting it.` }
      }
      const { error: linked } = await insforge.database
        .from('director_shots')
        .update({ clip_id: clipId, status: 'rendering' })
        .eq('id', s.id)
      if (linked) {
        return { error: `Shot #${s.position}: the clip was queued but could not be linked to the shot - ${linked.message}` }
      }

      const out = parseFlowJson<{ action: string; videoPath?: string; reason?: string }>(
        await triggerFlow(guided ? extendId : i2vId, { clipId })
      )
      // The flow answers {action:'error'|'pending'} inside a 200, so a parsed
      // reply is not the same as a rendered clip.
      if (!out.ok || out.data.action !== 'complete') {
        const why = out.ok ? out.data.reason ?? out.data.action : out.message
        // Reported by the caller; the status write below still has to happen.
        // Result ignored on purpose: the real failure is already being
        // reported, and a second error about the status write would bury it.
        await insforge.database.from('director_shots').update({ status: 'failed' }).eq('id', s.id)
        return { error: `Shot #${s.position}: ${why}` }
      }
      const { error: marked } = await insforge.database
        .from('director_shots')
        .update({ status: 'rendered' })
        .eq('id', s.id)
      if (marked) {
        return { error: `Shot #${s.position}: rendered, but could not be marked done - ${marked.message}` }
      }
    return { clipId }
  }

  const [clipping, setClipping] = useState<string | null>(null)

  /**
   * Render just this shot's clip.
   *
   * The Clips stage does every shot that has not been rendered, which is the
   * wrong tool when one shot came out badly and the other forty are fine. Same
   * render underneath - only the selection differs.
   */
  async function renderOneClip(shot: DirectorShot) {
    let s = shot
    setClipping(s.id)
    setError(null)
    try {
      // A "continue" shot carries the previous clip forward, so it still needs
      // to know what came before it even when only this one is being rendered.
      // An edited motion prompt is written first: renderClipFor reads the shot
      // row, so an unsaved edit would render the old wording and look ignored.
      const edited = motionDraft[s.id]
      if (edited !== undefined && edited !== s.motion_prompt) {
        const { error: saved } = await insforge.database
          .from('director_shots')
          .update({ motion_prompt: edited })
          .eq('id', s.id)
        if (saved) {
          setError(`Shot ${s.position}: the edited motion prompt could not be saved - ${saved.message}`)
          return
        }
        s = { ...s, motion_prompt: edited }
      }
      const prev = shots[shots.indexOf(s) - 1]
      const made = await renderClipFor(s, prev ? prev.clip_id : null)
      if ('error' in made) {
        setError(made.error)
        return
      }
      setReviewNote(`Shot ${s.position}: clip rendered.`)
      await loadShots(planId)
    } finally {
      setClipping(null)
    }
  }
  async function runClips() {
    const i2vId = import.meta.env.VITE_MINIMAX_I2V_ID
    const extendId = import.meta.env.VITE_MINIMAX_EXTEND_ID
    if (!i2vId || !extendId) {
      setError('VITE_MINIMAX_I2V_ID / VITE_MINIMAX_EXTEND_ID are not set in .env.')
      return
    }
    // Not `!s.clip_id`: a shot whose render FAILED keeps the clip row it was
    // given, so filtering on clip_id alone would skip it for ever. Anything not
    // actually rendered is still to do, and gets a fresh clip row.
    const remaining = shots.filter((s) => s.status !== 'rendered')
    if (remaining.length === 0) {
      setError('Every shot already has a clip.')
      return
    }
    const todo = remaining.filter((s) => inRange(s.position))
    if (todo.length === 0) {
      setError(`Nothing left to do in ${rangeNote}.`)
      return
    }
    stopRef.current = false
    setError(null)
    setStage('clips')
    let done = 0
    // Clip ids as they are made, so a `continue` shot can find the one before it
    // even when that clip was rendered moments ago in this same run.
    const clipOf = new Map<string, string>(
      shots.filter((s) => s.clip_id).map((s) => [s.id, s.clip_id as string])
    )
    for (const s of todo) {
      if (stopRef.current) break
      setProgress({ done, total: todo.length, label: `shot #${s.position}` })
      const prev = shots[shots.indexOf(s) - 1]
      const prevClip = prev ? clipOf.get(prev.id) ?? prev.clip_id : null
      setProgress({ done, total: todo.length, label: `shot #${s.position}` })
      const made = await renderClipFor(s, prevClip)
      if ('error' in made) {
        setError(made.error)
        break
      }
      clipOf.set(s.id, made.clipId)
      done++
      setProgress({ done, total: todo.length, label: `shot #${s.position}` })
      await loadShots(planId)
    }
    setStage(null)
    setProgress(null)
    await loadShots(planId)
  }

  /**
   * Render through the MiniMax H3 Context Loop chain instead of our own clip
   * flow (DIRECTOR.md 7b).
   *
   * One call per scene, because their loop renders a scene, checkpoints it and
   * stops. Driving the sequence from here keeps the stop, resume and shot range
   * the other stages already have. Scenes go in order: a scene above the first
   * needs its predecessor's checkpoint to continue from.
   */
  async function runContextLoop() {
    const flowId = import.meta.env.VITE_DIRECTOR_ID
    if (!flowId || !plan) {
      setError('VITE_DIRECTOR_ID is not set, or no plan is selected.')
      return
    }
    const todo = shots.filter((s) => inRange(s.position)).sort((a, b) => a.position - b.position)
    if (todo.length === 0) {
      setError(`Nothing to render in ${rangeNote}.`)
      return
    }
    stopRef.current = false
    setError(null)
    setStage('contextloop')
    let done = 0
    for (const s of todo) {
      if (stopRef.current) break
      setProgress({ done, total: todo.length, label: `scene ${s.position}` })
      const res = parseFlowJson<{ action: string; segment?: string; reason?: string; detail?: string }>(
        await triggerFlow(flowId, { movieId: movie.id, planId: plan.id, mode: 'render', scene: s.position })
      )
      // The flow answers {action:'error'|'pending'} inside a 200, so a parsed
      // reply is not the same as a rendered scene.
      if (!res.ok || res.data.action !== 'rendered') {
        const why = res.ok ? res.data.reason ?? res.data.detail ?? res.data.action : res.message
        setError(`Scene ${s.position}: ${why}`)
        // Result ignored on purpose: the real failure is already being
        // reported, and a second error about the status write would bury it.
        await insforge.database.from('director_shots').update({ status: 'failed' }).eq('id', s.id)
        break
      }
      const { error: marked } = await insforge.database
        .from('director_shots')
        .update({ status: 'rendered' })
        .eq('id', s.id)
      if (marked) {
        setError(`Scene ${s.position}: rendered, but could not be marked done - ${marked.message}`)
        break
      }
      done++
      setProgress({ done, total: todo.length, label: `scene ${s.position}` })
      await loadShots(planId)
    }
    setStage(null)
    setProgress(null)
    await loadShots(planId)
  }

  /**
   * Stitch every clip already rendered for this plan into one cut.
   *
   * Not a render: the flow keeps only the pack's RECOVERY assemble and the
   * nodes it depends on, which leaves the sampler unreachable, so this costs no
   * GPU time. It reads the checkpoints in the plan's run folder - which is why
   * it works after a redo: replace one clip, assemble again.
   */
  async function runAssemble() {
    const flowId = import.meta.env.VITE_DIRECTOR_ID
    if (!flowId || !plan) {
      setError('VITE_DIRECTOR_ID is not set, or no plan is selected.')
      return
    }
    setError(null)
    setStage('assemble')
    setProgress({ done: 0, total: 1, label: 'stitching the clips' })
    try {
      const res = parseFlowJson<{ action: string; cut?: string; clips?: number; reason?: string; detail?: string }>(
        await triggerFlow(flowId, { movieId: movie.id, planId: plan.id, mode: 'assemble' })
      )
      if (!res.ok || res.data.action !== 'assembled') {
        setError(res.ok ? (res.data.reason ?? res.data.detail ?? res.data.action) : res.message)
        return
      }
      await loadPlans(plan.id)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setStage(null)
      setProgress(null)
    }
  }

  /**
   * The continuity pass.
   *
   * Runs between First frames and Clips, which is the only moment both signals
   * exist: the text is written, the pictures are rendered, and no clip time has
   * been spent. It flags and changes nothing - every remedy is yours to apply,
   * because a pass that silently re-rendered would spend GPU on its own guesses.
   */
  async function runReview() {
    const flowId = import.meta.env.VITE_DIRECTOR_ID
    if (!flowId || !plan) {
      setError('VITE_DIRECTOR_ID is not set, or no plan is selected.')
      return
    }
    setError(null)
    setStage('review')
    setProgress({ done: 0, total: 1, label: 'reading the frames' })
    try {
      const res = parseFlowJson<{
        action: string
        checked?: number
        pairs?: number
        framesRead?: number
        findings?: { state: string; note: string }[]
        note?: string
        reason?: string
      }>(await triggerFlow(flowId, { movieId: movie.id, planId: plan.id, mode: 'review', fromPos, toPos }))
      if (!res.ok || res.data.action !== 'reviewed') {
        setError(res.ok ? (res.data.reason ?? res.data.action) : res.message)
        return
      }
      const n = res.data.findings?.length ?? 0
      setReviewNote(
        n === 0
          ? `Checked ${res.data.checked} shots across ${res.data.pairs} pairs - everything agrees.`
          : `${n} thing${n === 1 ? '' : 's'} to look at across ${res.data.checked} shots. They are marked in the shot list.`
      )
      await loadShots(planId)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setStage(null)
      setProgress(null)
    }
  }

  /**
   * Re-check a window after a repair, and let the pass write the verdict.
   *
   * The window is three wide - the shot and its neighbours - because the pair
   * checks need someone to compare against; on its own only the identity check
   * could run. The pass clears every shot it looks at to "ok" before applying
   * what it finds, so a fix that worked removes the flag and a fix that did not
   * keeps it with a fresh reason.
   */
  async function verifyAround(positions: number[]) {
    const flowId = import.meta.env.VITE_DIRECTOR_ID
    if (!flowId || !plan || !positions.length) return
    const lo = Math.max(1, Math.min(...positions) - 1)
    const hi = Math.max(...positions) + 1
    setProgress({ done: 0, total: 1, label: 'checking the new picture' })
    const res = parseFlowJson<{ action: string; findings?: unknown[] }>(
      await triggerFlow(flowId, { movieId: movie.id, planId: plan.id, mode: 'review', fromPos: lo, toPos: hi })
    )
    return res.ok && res.data.action === 'reviewed' ? (res.data.findings?.length ?? 0) : null
  }

  /**
   * Act on one finding from the continuity pass.
   *
   * A re-render only: the shot's own prompt plus the constraint the pass wrote,
   * which is the whole reason the constraint is stored rather than just the
   * complaint. `needs_shot` has no remedy here - no re-render can add a moment
   * the script never had - so it is refused rather than silently doing the wrong
   * thing.
   */
  async function fixShot(s: DirectorShot) {
    const flowId = import.meta.env.VITE_IMAGE_EDIT_ID
    if (!flowId) {
      setError('VITE_IMAGE_EDIT_ID is not set in .env.')
      return
    }
    if (s.review_state === 'needs_shot') {
      setError(`Shot ${s.position} needs a shot inserted before it, which is not a re-render. That is the next thing being built.`)
      return
    }
    if (!s.frame_prompt) {
      setError(`Shot ${s.position} has no frame prompt to re-render.`)
      return
    }
    // Without a constraint this re-renders the identical prompt, which returns
    // an identical picture and looks like a broken button. It happens to any
    // finding written before the constraint was stored: the complaint survives,
    // the repair does not.
    if (!s.review_constraint) {
      setError(
        `Shot ${s.position} was flagged without a correction to apply, so re-rendering would send the same prompt again. Run Review frames to work out the fix, then press this.`
      )
      return
    }
    setError(null)
    setStage('fixing')
    setProgress({ done: 0, total: 1, label: `shot ${s.position}` })
    try {
      // The constraint goes last, so it is the final thing the renderer reads.
      const prompt = [s.frame_prompt, s.review_constraint].filter(Boolean).join(' ')
      const out = await renderOneFrame(s, prompt, flowId)
      if (!out) return
      // Verified, not assumed. Clearing the flag here would have made a failed
      // repair look exactly like a successful one - the button would vanish and
      // the picture would still be wrong.
      const left = await verifyAround([s.position])
      await loadShots(planId)
      setReviewNote(
        left === null
          ? `Shot ${s.position} re-rendered, but the check did not run - press Review frames to confirm it.`
          : left === 0
            ? `Shot ${s.position} re-rendered and now agrees with its neighbours.`
            : `Shot ${s.position} re-rendered, but ${left} thing(s) still do not agree. The reason has been updated.`
      )
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setStage(null)
      setProgress(null)
    }
  }

  /**
   * Keep fixing and re-checking until nothing is left to fix.
   *
   * One pass of "Redo all flagged" repairs what it can and then re-checks, which
   * usually turns up a SECOND round: a re-rendered shot now agrees with its own
   * text but no longer matches its neighbour, and that neighbour was not flagged
   * before. Pressing the button again by hand is the same work done manually, so
   * this does it in a loop.
   *
   * Each pass: rebuild the prompts, render every flagged shot with the correction
   * the review wrote, check the result, repeat.
   *
   * WHAT STOPS IT. Not a pass count, and not a clock - a render is stochastic, so
   * a second attempt at the same shot can succeed where the first failed, and
   * guessing "three tries is enough" would throw away work that was about to
   * land. It stops when there is nothing flagged, when two passes in a row fail
   * to reduce the count (the remaining findings are ones re-rendering cannot
   * reach - usually a missing moment, which needs a shot inserted, not a redo),
   * or when you press Stop. Every pass is reported as it happens, so a loop that
   * is not getting anywhere is visible rather than silent.
   */
  async function fixUntilClean() {
    const flowId = import.meta.env.VITE_IMAGE_EDIT_ID
    if (!flowId) {
      setError('VITE_IMAGE_EDIT_ID is not set in .env.')
      return
    }
    if (!plan) return
    stopRef.current = false
    setError(null)
    setStage('fixing')
    const log: string[] = []
    let pass = 0
    let stale = 0
    let lastLeft = Number.POSITIVE_INFINITY
    let rendered = 0
    try {
      for (;;) {
        if (stopRef.current) {
          log.push('stopped')
          break
        }
        pass++
        // Read fresh every pass. A shot flagged by the check at the end of the
        // previous pass is not in this component's state yet, and those are
        // exactly the ones this loop exists to pick up.
        const { data } = await insforge.database
          .from('director_shots')
          .select('*')
          .eq('plan_id', plan.id)
          .order('position', { ascending: true })
        const rows = (data ?? []) as DirectorShot[]
        const flagged = rows.filter(
          (s) => inRange(s.position) && s.review_state && REDOABLE.includes(s.review_state)
        )
        if (!flagged.length) {
          log.push(`pass ${pass}: nothing flagged`)
          break
        }
        const todo = flagged.filter((s) => s.review_constraint && s.frame_prompt)
        if (!todo.length) {
          log.push(
            `pass ${pass}: ${flagged.length} flagged but carrying no correction - run Review frames to work them out`
          )
          break
        }
        // Dress the people and rewrite the prompts, so the repair is applied to
        // the current wardrobe rather than to whatever this prompt was drafted
        // with. The correction itself is appended after, last in the prompt.
        const ready = await redress(todo)
        const touched: number[] = []
        let n = 0
        const run = await pool(ready.shots, IN_FLIGHT, () => stopRef.current, async (s) => {
          const out = await renderOneFrame(s, withFix(s.frame_prompt ?? '', s), flowId, ready.dressed)
          if ('error' in out) return { error: `Shot ${s.position}: ${out.error}` }
          touched.push(s.position)
          n++
          rendered++
          setProgress({ done: n, total: ready.shots.length, label: `pass ${pass}, shot ${s.position}` })
        })
        if (run.error) {
          setError(run.error)
          log.push(`pass ${pass}: stopped on an error after ${n}`)
          break
        }
        const left = touched.length ? await verifyAround(touched) : null
        if (left === null || left === undefined) {
          log.push(`pass ${pass}: re-rendered ${n}, but the check did not run`)
          break
        }
        log.push(`pass ${pass}: re-rendered ${n}, ${left} left`)
        if (left === 0) break
        // No progress twice running means the rest is not a re-render problem.
        stale = left >= lastLeft ? stale + 1 : 0
        lastLeft = left
        if (stale >= 2) {
          log.push('two passes without progress - the rest needs a shot inserted, not a redo')
          break
        }
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setStage(null)
      setProgress(null)
      await loadShots(planId)
      setReviewNote(`${rendered} re-render(s) over ${pass} pass(es). ` + log.join('; ') + '.')
    }
  }

  /** Every finding a re-render can fix, in order. Stoppable. */
  async function fixAllFrames() {
    const flowId = import.meta.env.VITE_IMAGE_EDIT_ID
    if (!flowId) {
      setError('VITE_IMAGE_EDIT_ID is not set in .env.')
      return
    }
    // A finding with no constraint would re-send the identical prompt, so it is
    // not counted as fixable - it needs Review frames run again.
    const flagged = shots.filter(
      (s) => inRange(s.position) && s.review_state && ['redo_frame', 'redo_prev', 'redo_next'].includes(s.review_state)
    )
    const todo = flagged.filter((s) => s.review_constraint && s.frame_prompt)
    if (!todo.length) {
      setError(
        flagged.length
          ? `${flagged.length} shot(s) are flagged but carry no correction to apply. Run Review frames to work them out, then press this.`
          : 'Nothing the pass flagged can be fixed by re-rendering.'
      )
      return
    }
    stopRef.current = false
    setError(null)
    setStage('fixing')
    let done = 0
    // The positions actually re-rendered, collected as they land. Slicing the
    // first `done` items off the list assumed they complete in order, which is
    // exactly what running several at once stops being true - it would verify
    // shots that were never touched and skip ones that were.
    const touched: number[] = []
    const run = await pool(todo, IN_FLIGHT, () => stopRef.current, async (s) => {
      try {
        const prompt = [s.frame_prompt, s.review_constraint].filter(Boolean).join(' ')
        const out = await renderOneFrame(s, prompt, flowId)
        if ('error' in out) return { error: `Shot ${s.position}: ${out.error}` }
        // Not cleared here: the verify pass at the end decides what every
        // touched shot's verdict is, from the new pictures.
        touched.push(s.position)
        done++
        setProgress({ done, total: todo.length, label: `shot ${s.position}` })
      } catch (e) {
        return { error: e instanceof Error ? e.message : String(e) }
      }
    })
    if (run.error) setError(run.error)
    const left = touched.length ? await verifyAround(touched) : 0
    setStage(null)
    setProgress(null)
    await loadShots(planId)
    setReviewNote(
      left === null
        ? `Re-rendered ${done} of ${todo.length}, but the check did not run - press Review frames to confirm them.`
        : left === 0
          ? `Re-rendered ${done} of ${todo.length}. Everything checked now agrees.`
          : `Re-rendered ${done} of ${todo.length}. ${left} thing(s) still do not agree.`
    )
  }

  /**
   * The shimmy: one shot, written by hand, put in where the automation left a
   * gap.
   *
   * The flow runs it through the SAME builder a planned shot goes through, so it
   * comes out carrying the character anchors, the prop and wardrobe bindings,
   * the camera line, and the scene's light, staging and sound bed. Nothing here
   * writes a prompt - that would be a second builder, and the two would drift.
   */
  /**
   * Insert every missing shot the pass found and wrote.
   *
   * The row button does one gap at a time and opens the box so you can read what
   * it wrote first. This is the same thing for all of them at once, for when you
   * have read a few and trust the rest.
   *
   * BACK TO FRONT, and that is not a preference. `(plan_id, position)` is unique
   * and NOT deferrable, so inserting at 4 shifts 4, 5, 6... down by one inside
   * that call. Going forwards, the second insert's position would have been
   * computed against a list that no longer exists and would land a shot in the
   * wrong place - or collide outright. Taking the highest first means every
   * position still ahead of the work is untouched.
   *
   * The cast comes from whoever is in BOTH neighbours, because the move that was
   * never shown belongs to them, and a move needs room - never a close-up.
   */
  async function insertAllGaps() {
    const flowId = import.meta.env.VITE_DIRECTOR_ID
    if (!flowId || !plan) return
    const todo = gaps.filter((s) => inRange(s.position)).sort((a, b) => b.position - a.position)
    if (!todo.length) {
      setError('No gap has a shot written for it. Run Review frames, or use the row button to write one yourself.')
      return
    }
    stopRef.current = false
    setError(null)
    setStage('inserting')
    const landed: number[] = []
    const failed: string[] = []
    try {
      for (const s of todo) {
        if (stopRef.current) break
        setProgress({ done: landed.length, total: todo.length, label: `before shot ${s.position}` })
        const prev = shots.find((x) => x.position === s.position - 1)
        const mine = new Set((s.characters ?? []).map((n) => n.toUpperCase()))
        const shared = (prev?.characters ?? []).map((n) => n.toUpperCase()).filter((n) => mine.has(n))
        const res = parseFlowJson<{ action: string; position?: number; error?: string; reason?: string }>(
          await triggerFlow(flowId, {
            movieId: movie.id,
            planId: plan.id,
            mode: 'insert',
            position: s.position,
            scene: s.scene_number ?? 1,
            type: 'action',
            size: 'full',
            foreground: '',
            characters: shared.length ? shared : (s.characters ?? []).map((n) => n.toUpperCase()),
            action: s.review_constraint as string
          })
        )
        if (!res.ok || res.data.action !== 'inserted') {
          failed.push(`before ${s.position}: ${res.ok ? (res.data.error ?? res.data.reason ?? res.data.action) : res.message}`)
          continue
        }
        landed.push(res.data.position ?? s.position)
      }
      // Only the text half of the pass can answer now - the picture half needs
      // these to have frames first.
      if (landed.length) await verifyAround([Math.min(...landed), Math.max(...landed) + 1])
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setStage(null)
      setProgress(null)
      await loadShots(planId)
      setReviewNote(
        `${landed.length} shot(s) inserted${landed.length ? ' at ' + [...landed].sort((a, b) => a - b).join(', ') : ''}.` +
          (failed.length ? ` ${failed.length} did not go in: ${failed.join('; ')}.` : '') +
          (landed.length ? ' Render their first frames when you are ready.' : '')
      )
    }
  }

  async function runInsert() {
    const flowId = import.meta.env.VITE_DIRECTOR_ID
    if (!flowId || !plan || insertAt === null) return
    if (!insAction.trim()) {
      setError('Say what happens in the shot - that is what the prompt is written from.')
      return
    }
    setError(null)
    setStage('inserting')
    setProgress({ done: 0, total: 1, label: `shot ${insertAt}` })
    try {
      const at = shots.find((s) => s.position === insertAt)
      const res = parseFlowJson<{ action: string; position?: number; error?: string; reason?: string }>(
        await triggerFlow(flowId, {
          movieId: movie.id,
          planId: plan.id,
          mode: 'insert',
          position: insertAt,
          // The scene of the shot it goes in front of, so it inherits that
          // scene's light, staging and sound rather than starting a new one.
          scene: at?.scene_number ?? shots[shots.length - 1]?.scene_number ?? 1,
          type: insType,
          size: insSize,
          foreground: insForeground,
          characters: insWho,
          action: insAction,
          firstFramePath: insFirstFrame || undefined,
          lastFramePath: insLastFrame || undefined
        })
      )
      if (!res.ok || res.data.action !== 'inserted') {
        setError(res.ok ? (res.data.error ?? res.data.reason ?? res.data.action) : res.message)
        return
      }
      setInsertAt(null)
      setInsAction('')
      setInsWho([])
      setInsForeground('')
      setInsFirstFrame('')
      setInsLastFrame('')
      // The finding that sent you here sits on the shot that just moved down a
      // place, so it would otherwise stay on screen as a complaint about a gap
      // that no longer exists. The text half of the pass can answer this now -
      // the picture half cannot until the new shot has a frame.
      const landed = res.data.position ?? insertAt
      const left = await verifyAround([landed, landed + 1])
      await loadShots(planId)
      setReviewNote(
        left === 0
          ? `Shot inserted at ${landed}. The gap is covered. Render its first frame when you are ready.`
          : `Shot inserted at ${landed}. Render its first frame, then run Review frames to check it in the pictures.`
      )
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setStage(null)
      setProgress(null)
    }
  }

  // Where each stage stands, read off the shots rather than stored twice.
  const framed = shots.filter((s) => s.first_frame_path).length
  const approved = shots.filter((s) => s.frame_approved).length
  const clipped = shots.filter((s) => s.clip_id).length
  const checked = shots.filter((s) => s.status === 'checked').length
  const stageDone: Record<string, string> = {
    frames: `${framed} / ${shots.length}`,
    review: `${approved} / ${shots.length}`,
    clips: `${clipped} / ${shots.length}`,
    checks: `${checked} / ${shots.length}`,
    assemble: plan?.output_path ? 'done' : '-'
  }
  const totalSeconds = shots.reduce((n, s) => n + s.length_frames, 0) / 24
  // Shots the review flagged AND left a correction for. A flag without one would
  // re-send the identical prompt, so it is not something this button can fix.
  const flagged = shots.filter(
    (s) =>
      s.review_state &&
      ['redo_frame', 'redo_prev', 'redo_next'].includes(s.review_state) &&
      s.review_constraint
  )
  // Gaps the pass found AND wrote a shot for. One with no proposed action is
  // left to the row's own button, where you type it - counting it here would
  // promise something this cannot deliver.
  const gaps = shots.filter((s) => s.review_state === 'needs_shot' && s.review_constraint)

  return (
    <div>
      <p>
        The Director plans {movie.title} as a shot list from its beats and characters, then produces it
        in stages you approve. Planning, first frames, clips and assemble are built; review and checks
        are not wired yet.
      </p>

      {/* Two things a shot list cannot work out for itself. Written once per
          scene and held by every shot in it - the same shape of fix as the
          sound bed, which is what stopped the sound changing at every cut.
          Fill these in BEFORE drafting: the draft bakes them into every frame. */}
      <h4>Scene look</h4>
      <p className="empty">
        Where the light comes from, and which way things lie on screen. Every shot in the scene is
        framed and lit to match. Leave one blank and its shots go back to being lit however each
        render feels like.
      </p>
      {/* Cards, not a table. As a table this fought the shot list's fixed
          column widths, the headers collided, and the location wrapped onto two
          lines - and the fixes did not stick because App.css sits in @layer
          legacy, the lowest in the cascade, so theme.css overrode them. Two long
          text fields per scene want a card anyway. */}
      <div className="clip-grid">
        {sceneLook.map((sc) => (
          <div className="beat-card" key={sc.scene_number}>
            <p>
              <strong>Scene {sc.scene_number}</strong>{' '}
              <span className="empty">{sc.location_name ?? 'no location'}</span>
            </p>
            <label className="field-stack">
              Light — direction and quality
              <input
                defaultValue={sc.key_light ?? ''}
                placeholder="low golden sun from screen-left, strong rim"
                disabled={drafting || stage !== null}
                onBlur={(e) => {
                  const v = e.target.value.trim() || null
                  if (v !== (sc.key_light ?? null)) patchScene(sc.scene_number, { key_light: v })
                }}
              />
            </label>
            <label className="field-stack">
              Screen direction — what lies which way
              <input
                defaultValue={sc.screen_direction ?? ''}
                placeholder="the city is screen-left, the stairwell door is screen-right"
                disabled={drafting || stage !== null}
                onBlur={(e) => {
                  const v = e.target.value.trim() || null
                  if (v !== (sc.screen_direction ?? null))
                    patchScene(sc.scene_number, { screen_direction: v })
                }}
              />
            </label>
            {/* Where things STAND relative to each other. Screen direction says
                which way the scene faces; this says where the car is next to the
                person beside it - without it that moved between shots. */}
            <label className="field-stack">
              Staging — where things stand
              <input
                defaultValue={sc.staging ?? ''}
                placeholder="the a vehicle is parked screen-left, nose toward the ramp; Doc stands at its open door"
                disabled={drafting || stage !== null}
                onBlur={(e) => {
                  const v = e.target.value.trim() || null
                  if (v !== (sc.staging ?? null)) patchScene(sc.scene_number, { staging: v })
                }}
              />
            </label>
            {/* The panorama generator hard-coded "photorealistic, cinematic",
                so an anime film got a photoreal plate under its cast. Same
                treatment as characters and props. */}
            <label className="field-stack">
              Panorama drawn as
              <Select
                value={sc.render_style ?? 'photographic'}
                onValueChange={(v) => patchScene(sc.scene_number, { render_style: v })}
                items={[
                  { value: 'anime', label: 'Anime' },
                  { value: 'cartoon', label: 'Cartoon' },
                  { value: 'animated', label: '3D animated' },
                  { value: 'photographic', label: 'Photographic' }
                ]}
                disabled={drafting || stage !== null}
              />
            </label>
          </div>
        ))}
        {sceneLook.length === 0 && <p className="empty">No scenes yet.</p>}
      </div>

      <h4>1. Plan</h4>
      <div className="upload-form">
        <label
          className="field-stack"
          title="A guide, not a quota: the film is as long as covering the script makes it (DIRECTOR.md 5.9)"
        >
          Runtime wanted (guide, seconds)
          <input
            type="number"
            min={15}
            max={900}
            step={5}
            value={targetSeconds}
            onChange={(e) => setTargetSeconds(Number(e.target.value))}
          />
        </label>
        <button type="button" disabled={busy} onClick={handleNewPlan}>
          New plan
        </button>
        {plans.length > 0 && (
          <label>
            Plan
            <Select
              value={planId}
              onValueChange={setPlanId}
              items={plans.map((p) => ({
                value: p.id,
                label: `${new Date(p.created_at).toLocaleString()} · ${p.target_seconds}s · ${p.status}`
              }))}
            />
          </label>
        )}
        <button type="button" disabled={busy || drafting} onClick={handleDryRun}>
          {busy ? 'Checking…' : 'Check what it would plan from'}
        </button>
        <button
          type="button"
          disabled={!plan || drafting || busy}
          title={
            !plan
              ? 'Make or pick a plan first'
              : busy
                ? 'A check is still running - press Reset if it is stuck'
                : 'The LLM drafts the shot list; nothing is generated'
          }
          onClick={handleDraft}
        >
          {drafting ? 'Drafting… (a minute or two)' : 'Draft shot list'}
        </button>
        {/* A disabled button that says nothing is how twenty clicks did nothing:
            a hung call left busy/drafting true with no way back but a reload. */}
        {(busy || drafting) && (
          <button
            type="button"
            title="Clears a stuck Checking/Drafting state without reloading the page"
            onClick={() => {
              setBusy(false)
              setDrafting(false)
              setError('Reset - the previous call was abandoned. It may still be running on the server.')
            }}
          >
            Reset
          </button>
        )}
      </div>
      {planResult && (
        <>
          <p className="empty">
            Drafted {planResult.shots} shots · <strong>{planResult.runtime}</strong> · all {planResult.lines} lines
            covered
            {planResult.retried ? ' · the first draft broke a rule and was redone' : ''}
            {planResult.fixes.length > 0 && <> · fixed: {planResult.fixes.join('; ')}</>}
          </p>
          {/* 5.9: the runtime is what covering the script came to. If that is
              not the film you wanted, the answer is more script, not padding. */}
          {planResult.advice && <p className="empty">{planResult.advice}</p>}
        </>
      )}
      {dryRun && (
        <>
          <p className="empty">
            {dryRun.beats} beats across {dryRun.scenes} scenes · characters: {dryRun.characters.join(', ') || 'none'}
          </p>
          <p className="empty">
            This script is <strong>{dryRun.runtime}</strong> of film — {dryRun.shots} shots:{' '}
            {dryRun.breakdown.dialogue} dialogue, {dryRun.breakdown.reactions} reactions,{' '}
            {dryRun.breakdown.establishing} establishing, up to {dryRun.breakdown.action} action. {dryRun.note}
          </p>
          {dryRun.advice && <p className="empty">{dryRun.advice}</p>}
        </>
      )}
      {error && <p className="error">{error}</p>}
      {reviewNote && <p className="run-status-ok">{reviewNote}</p>}

      <h4>2. Shot list</h4>
      {!plan && <p className="empty">Make a plan to start.</p>}
      {plan && shots.length === 0 && (
        <p className="empty">No shots yet - the planning pass that fills this list is the next piece to build.</p>
      )}
      {shots.length > 0 && (
        <>
          <p className="empty">
            {shots.length} shots · {totalSeconds.toFixed(1)}s planned of {plan?.target_seconds}s
          </p>
          {/* Every shot wearing a checkmark, queued in one go. It sat down in
              Produce, away from the marks it acts on - this is where you can see
              which shots it will touch. Only shown when there is something to
              do, and it counts only what it can actually fix: a flag with no
              correction stored would re-send the identical prompt. */}
          {/* Everything that acts on the ticked shots, in one bar that is only
              there when something is ticked. It used to be a row of differently
              sized controls with floating labels, present whether or not there
              was a selection to act on. */}
          {picked.length > 0 && (
            <div className="bulk-bar">
              <span className="bulk-count">
                {picked.length} ticked
                <button type="button" className="linkish" onClick={() => setPicked([])}>
                  untick
                </button>
              </span>

              {/* The ones you just changed. Straight after setting a costume or a
                  set, this is the button you want - not "all the flagged ones". */}
              <button
                type="button"
                className="bulk-primary"
                disabled={stage !== null || drafting}
                title="Render the ticked shots again with their current prompts and references"
                onClick={redoPicked}
              >
                {stage === 'fixing' && progress ? `redoing ${progress.done}/${progress.total}` : `redo these ${picked.length}`}
              </button>

              {/* The set: one background, several shots. Four angles of one
                  storefront is four shots, not four prompts. */}
              <span className="bulk-group">
                <span className="bulk-label">Set</span>
                <ImageSelect
                  value=""
                  onValueChange={(id) => {
                    const src = sources.find((x) => x.id === id)
                    if (src) applyPlate(src.path)
                  }}
                  groups={pickerGroups}
                  placeholder="Place them on…"
                  disabled={stage !== null || drafting}
                  resetAfterPick
                />
                <button type="button" disabled={stage !== null} onClick={() => applyPlate(null)}>
                  none
                </button>
              </span>

              {/* Costume changes. A change mid-act is expressed here: tick from
                  the shot it comes off onward, and take it off. */}
              {propRefs.some((pr) => pr.kind === 'wardrobe') && (
                <span className="bulk-group">
                  <span className="bulk-label">Wearing</span>
                  {[
                    ...new Set(
                      shots
                        .filter((x) => picked.includes(x.id))
                        .flatMap((x) => (x.characters ?? []).map((c) => c.toUpperCase()))
                    )
                  ].map((name) => {
                    // What this person has on across the ticked shots. If the
                    // shots disagree the control says so rather than silently
                    // showing one of them and overwriting the rest on any touch.
                    const each = shots
                      .filter((x) => picked.includes(x.id) && (x.characters ?? []).some((c) => c.toUpperCase() === name))
                      .map((x) => wornIn(x).find((w) => w.on === name)?.prop ?? '')
                    const same = each.every((v) => v === each[0])
                    return (
                      <span key={name} className="bulk-toggle">
                        {name}
                        <Select
                          value={same ? (each[0] ?? '') : ''}
                          onValueChange={(v) => dressCharacter(name, v || null)}
                          items={[
                            { value: '', label: same ? 'nothing' : 'mixed - pick to set all' },
                            ...propRefs
                              .filter((pr) => pr.kind === 'wardrobe')
                              .map((pr) => ({
                                value: pr.id,
                                // A tick means there is a picture of this person
                                // already wearing it, so the shot render gets one
                                // reference instead of two.
                                label: dressed.some((d) => d.character === name && d.prop === pr.id)
                                  ? `${pr.label} ✓`
                                  : pr.label
                              }))
                          ]}
                          disabled={stage !== null}
                        />
                        {/* No dressed picture for this pair yet: make one, and
                            every shot where they wear it uses it. Without it the
                            render is handed the person and the garment separately
                            and asked to combine them, every single shot. */}
                        {/* Made automatically when the costume is set, so this
                            is only for making it AGAIN when the first one is not
                            good enough. */}
                        {same && each[0] && dressed.some((d) => d.character === name && d.prop === each[0]) && (
                          <button
                            type="button"
                            disabled={stage !== null}
                            title={`Render ${name} wearing it again, replacing the picture every shot uses`}
                            onClick={() => makeDressed(name, each[0])}
                          >
                            {stage === 'dressing' ? 'dressing…' : 'redo it'}
                          </button>
                        )}
                      </span>
                    )
                  })}
                  <button
                    type="button"
                    disabled={stage !== null}
                    title="Forget the per-shot choice and let the screenplay decide again"
                    onClick={() => setShotWardrobe(null, true)}
                  >
                    default
                  </button>
                </span>
              )}
            </div>
          )}
          {flagged.length > 0 && (
            <p>
              <button
                type="button"
                disabled={stage !== null || drafting}
                title="Re-renders every frame the review flagged, each with the correction it wrote, then checks the new pictures."
                onClick={fixAllFrames}
              >
                {stage === 'fixing'
                  ? `Redoing… ${progress ? `${progress.done} of ${progress.total}` : ''}`
                  : `Redo ${flagged.length} flagged frame${flagged.length === 1 ? '' : 's'}`}
              </button>{' '}
              <button
                type="button"
                disabled={stage !== null || drafting}
                title="Repairs, re-checks and repeats until nothing is flagged. Stops on its own when two passes make no progress - what is left then needs a shot inserted, not a redo. Press Stop to end it early."
                onClick={fixUntilClean}
              >
                Redo until clean
              </button>{' '}
            {gaps.length > 0 && (
              <button
                type="button"
                disabled={stage !== null || drafting}
                title="Inserts the shot the review wrote for each gap, back to front so the positions stay right. Read one with the row button first if you want to see what it says."
                onClick={insertAllGaps}
              >
                {stage === 'inserting'
                  ? `Inserting… ${progress ? `${progress.done} of ${progress.total}` : ''}`
                  : `Add ${gaps.length} missing shot${gaps.length === 1 ? '' : 's'}`}
              </button>
            )}
            </p>
          )}
          <table className="data-table director-shots">
            <thead>
              <tr>
                <th className="col-tick">
                  <input
                    type="checkbox"
                    title="Tick every shot"
                    checked={picked.length > 0 && picked.length === shots.length}
                    onChange={(e) => setPicked(e.target.checked ? shots.map((x) => x.id) : [])}
                  />
                </th>
                <th className="col-num">#</th>
                <th className="col-frame">Frame</th>
                <th className="col-clip">Clip</th>
                <th className="col-scene">Scene</th>
                <th className="col-type">Type</th>
                <th className="col-type">Size</th>
                <th className="col-cast">Characters</th>
                <th className="col-len">Length</th>
                <th className="col-cont">Continuity</th>
                <th>What happens · first-frame prompt</th>
                <th className="col-status">Status</th>
              </tr>
            </thead>
            <tbody>
              {shots.map((s, i) => (
                // A rule above each new scene: the only structure a flat shot
                // list has, and what you read it by. The insert form, when open,
                // is a second row above it - hence the fragment.
                <Fragment key={s.id}>
                {insertAt === s.position && (
                  <tr>
                    <td colSpan={12}>
                      <div className="beat-card">
                        <p>
                          <strong>New shot before #{s.position}</strong>{' '}
                          <span className="empty">
                            scene {s.scene_number} - it inherits that scene's light, staging and sound
                          </span>
                        </p>
                        {s.review_state === 'needs_shot' && s.review_note && (
                          <p className="empty">
                            <strong>Why:</strong> {s.review_note}
                          </p>
                        )}
                        <label className="field-stack">
                          What happens
                          <input
                            value={insAction}
                            autoFocus
                            placeholder="a character walks to the a vehicle and climbs in behind the wheel"
                            onChange={(e) => setInsAction(e.target.value)}
                          />
                        </label>
                        {/* Who is in it decides which reference sheets the frame
                            render gets, so it is a list of the real cast rather
                            than free text. */}
                        <label className="field-stack">
                          Who is in it
                          <span>
                            {Object.keys(charRefs).map((n) => (
                              <button
                                type="button"
                                key={n}
                                className={insWho.includes(n) ? 'badge' : 'badge unresolved'}
                                onClick={() =>
                                  setInsWho(insWho.includes(n) ? insWho.filter((x) => x !== n) : [...insWho, n])
                                }
                              >
                                {n}
                              </button>
                            ))}
                            {Object.keys(charRefs).length === 0 && (
                              <span className="empty">No cast with references yet.</span>
                            )}
                          </span>
                        </label>
                        <label className="field-stack">
                          What it is for
                          <Select
                            value={insType}
                            onValueChange={setInsType}
                            items={['establishing', 'wide', 'medium', 'close', 'reaction', 'cutaway', 'insert', 'action'].map(
                              (v) => ({ value: v, label: v })
                            )}
                          />
                        </label>
                        <label className="field-stack">
                          How close
                          <Select
                            value={insSize}
                            onValueChange={setInsSize}
                            items={['wide', 'full', 'medium', 'medium_close', 'close', 'insert'].map((v) => ({
                              value: v,
                              label: v
                            }))}
                          />
                        </label>
                        <label className="field-stack">
                          One thing near the lens
                          <input
                            value={insForeground}
                            placeholder="the open car door"
                            onChange={(e) => setInsForeground(e.target.value)}
                          />
                        </label>
                        {/* A picture from the gallery as the shot's first frame -
                            and optionally the frame it must END on, which is how
                            an arrival lands exactly where the next shot starts. */}
                        <label className="field-stack">
                          First frame (optional)
                          <ImageSelect
                            value={insFirstFrame}
                            onValueChange={(id) => setInsFirstFrame(sources.find((x) => x.id === id)?.path ?? '')}
                            groups={toPickerGroups(sources)}
                            placeholder="Pick a picture…"
                          />
                        </label>
                        <label className="field-stack">
                          Last frame (optional)
                          <ImageSelect
                            value={insLastFrame}
                            onValueChange={(id) => setInsLastFrame(sources.find((x) => x.id === id)?.path ?? '')}
                            groups={toPickerGroups(sources)}
                            placeholder="Pick a picture…"
                          />
                        </label>
                        <button type="button" disabled={stage !== null || !insAction.trim()} onClick={runInsert}>
                          {stage === 'inserting' ? 'Inserting…' : 'Insert the shot'}
                        </button>
                        <button type="button" disabled={stage !== null} onClick={() => setInsertAt(null)}>
                          Cancel
                        </button>
                      </div>
                    </td>
                  </tr>
                )}
                <tr className={i > 0 && s.scene_number !== shots[i - 1].scene_number ? 'scene-start' : undefined}>
                  <td className="col-tick">
                    <input
                      type="checkbox"
                      checked={picked.includes(s.id)}
                      onChange={(e) =>
                        setPicked(e.target.checked ? [...picked, s.id] : picked.filter((x) => x !== s.id))
                      }
                    />
                  </td>
                  <td className="col-num">
                    {s.position}
                  </td>
                  {/* Everything about this shot's picture, beside the shot.
                      It was a separate Gallery below, which meant scrolling
                      between the prompt and the result it produced - the two
                      things you compare. */}
                  <td className="col-frame">
                    {/* The frame and the clip it became, side by side. The
                        frame is what was asked for and the clip is what came
                        back, so they are the two things you compare - and
                        until now they lived in different tabs. */}
                    <div className="shot-media">
                      {s.first_frame_path ? (
                        <img
                          className="shot-thumb"
                          src={comfyViewUrl(s.first_frame_path)}
                          alt={`Shot ${s.position}`}
                        />
                      ) : (
                        <span className="empty">no frame</span>
                      )}
                    </div>
                    {/* One group, so they are the same size and colour and sit
                        side by side. The + was outside it and therefore missed
                        copper.css's opt-out list, which is why it rendered as a
                        full-size filled button on its own line. */}
                    <div className="row-actions">
                      {/* Put a shot in FRONT of this one. The gap the automation
                          left is always between two shots, so the handle belongs
                          on the row rather than in a toolbar. */}
                      <button
                        type="button"
                        className={s.review_state === 'needs_shot' ? 'icon fix' : 'icon shimmy'}
                        title={
                          s.review_state === 'needs_shot'
                            ? `Write the shot that covers the move, before #${s.position} - ${s.review_note ?? ''}`
                            : `Insert a shot before #${s.position}`
                        }
                        disabled={stage !== null || drafting}
                        onClick={() => {
                          setInsertAt(s.position)
                          setInsType('action')
                          setInsAction('')
                          setInsForeground('')
                          setInsFirstFrame('')
                          setInsLastFrame('')
                          if (s.review_state === 'needs_shot') {
                            // The action the review already wrote for this gap.
                            //
                            // On a needs_shot, review_constraint holds a PROPOSED
                            // ACTION rather than a correction - the one shot that
                            // gets from the previous frame to this one, written
                            // from both shots and from what the vision pass saw
                            // each person doing. Leaving the box empty here meant
                            // typing out a move the automation had already worked
                            // out in order to raise the finding at all.
                            //
                            // It is a proposal: it fills the box, it does not
                            // insert anything. Edit it or replace it before you
                            // press the button, exactly as before.
                            if (s.review_constraint) setInsAction(s.review_constraint)
                            // The move that was never shown belongs to whoever is
                            // in BOTH neighbours, and a move needs room, so it is
                            // never a close-up.
                            const prev = shots[i - 1]
                            const mine = new Set((s.characters ?? []).map((n) => n.toUpperCase()))
                            const shared = (prev?.characters ?? [])
                              .map((n) => n.toUpperCase())
                              .filter((n) => mine.has(n))
                            setInsWho(shared.length ? shared : (s.characters ?? []).map((n) => n.toUpperCase()))
                            setInsSize('full')
                          } else {
                            setInsWho([])
                            setInsSize('medium')
                          }
                        }}
                      >
                        +
                      </button>
                      <button
                        type="button"
                        className="icon"
                        disabled={stage !== null || redoing !== null}
                        title={s.first_frame_path ? 'Render this frame again with the prompt beside it' : 'Render this frame'}
                        onClick={() => redoFrame(s)}
                      >
                        {redoing === s.id ? '…' : '↻'}
                      </button>
                      {s.review_state && s.review_state !== 'ok' && s.review_state !== 'needs_shot' && s.review_state !== 'unresolved' && (
                        <button
                          type="button"
                          className="icon fix"
                          disabled={stage !== null || drafting}
                          title={s.review_constraint ?? 'Re-render with the correction the review wrote'}
                          onClick={() => fixShot(s)}
                        >
                          ✓
                        </button>
                      )}
                      {/* Beside the buttons rather than below them: it is a
                          label on this shot, not an action, and it was taking a
                          whole row to say two words. Pushed right by the CSS so
                          it never crowds the controls. */}
                      {s.plate_path && (
                        <span className="badge on-set" title={s.plate_path}>
                          on a set
                        </span>
                      )}
                    </div>
                    {/* Render this one shot. The Clips stage does every shot that
                        has not been rendered, which is the wrong tool when one
                        came out badly and the rest are fine. */}
                    <button
                      type="button"
                      className="grab-frame render-clip"
                      disabled={stage !== null || clipping !== null || !s.first_frame_path}
                      title={
                        s.first_frame_path
                          ? 'Render the clip for this shot only'
                          : 'Needs a first frame before it can be rendered'
                      }
                      onClick={() => renderOneClip(s)}
                    >
                      {clipping === s.id ? 'Rendering…' : 'Render clip'}
                    </button>
                    {/* A picture you already have instead - relit, graded, or
                        grabbed from a clip. One write, no render. */}
                    <ImageSelect
                      value=""
                      onValueChange={(id) => substituteFrame(s, id)}
                      groups={pickerGroups}
                      placeholder="Replace Image"
                      disabled={stage !== null || redoing !== null}
                      resetAfterPick
                    />
                  </td>
                  {/* The clip this shot became, in its own column beside the
                      frame that produced it. Sharing the frame cell meant one
                      column carrying the picture, the video and the row's
                      controls, and none of them had room. */}
                  <td className="col-clip">
                    {s.clip_id && clipPaths[s.clip_id] ? (
                      <>
                        <video
                          className="shot-clip"
                          src={comfyViewUrl(clipPaths[s.clip_id].path)}
                          controls
                          preload="metadata"
                          muted
                          playsInline
                        />
                        {/* A clip often lands on a better composition part-way
                            through than the still it started from. This is the
                            same picker the MiniMax tab extends from, so the frame
                            is saved the same way and lands in the same list. */}
                        <button
                          type="button"
                          className="grab-frame"
                          disabled={stage !== null}
                          onClick={() => {
                            setGrabFrame(0)
                            setGrabFor(grabFor === s.id ? null : s.id)
                          }}
                        >
                          {grabFor === s.id ? 'Close' : 'Export frame'}
                        </button>
                        {grabFor === s.id && (
                          <FramePicker
                            src={comfyViewUrl(clipPaths[s.clip_id].path)}
                            frames={clipPaths[s.clip_id].frames}
                            value={grabFrame}
                            onChange={setGrabFrame}
                            onCancel={() => setGrabFor(null)}
                            onConfirm={() => setGrabFor(null)}
                            confirmLabel="Done"
                            onGrab={async (png, frame) => {
                              const saved = await saveFrameToProject(movie, png, {
                                clipId: s.clip_id as string,
                                frame
                              })
                              if ('error' in saved) {
                                setError(saved.error)
                                return
                              }
                              // Into the Replace Image list without a reload.
                              refreshData()
                              setReviewNote(
                                `Frame ${frame} saved from shot ${s.position} - pick it under Replace Image.`
                              )
                            }}
                          />
                        )}
                      </>
                    ) : (
                      <span className="empty">no clip</span>
                    )}
                  </td>
                  <td className="col-scene">{s.scene_number ?? '-'}</td>
                  <td className="col-type">{s.shot_type ?? '-'}</td>
                  <td className="col-type">
                    {s.shot_size ?? '-'}
                    {s.foreground && (
                      <>
                        <br />
                        <span className="empty">{s.foreground}</span>
                      </>
                    )}
                  </td>
                  <td className="col-cast">{s.characters.join(', ') || '-'}</td>
                  {/* Generated length, then what the cut keeps of it (5.8). */}
                  <td className="col-len">
                    {(s.length_frames / 24).toFixed(1)}s
                    {s.use_frames != null && s.use_frames < s.length_frames && (
                      <>
                        <br />
                        <span className="empty">→ {(s.use_frames / 24).toFixed(1)}s</span>
                      </>
                    )}
                  </td>
                  <td className="col-cont">{s.continuity === 'continue' ? 'continues' : 'fresh'}</td>
                  <td>
                    <p className="empty">{s.notes || '(no description)'}</p>
                    {/* Folded away like the motion prompt below it. Both are long
                        enough to push a row past a screenful, and the description
                        above already says what the shot is - the prompt is only
                        wanted when something needs changing.

                        Still editable, and still next to the picture it produced:
                        seeing the two together is the only way to tell why a frame
                        came out wrong. Redo sends whatever is in this box. */}
                    <details>
                      <summary className="empty">Image prompt</summary>
                      <textarea
                        className="prompt-editor"
                        rows={3}
                        value={promptDraft[s.id] ?? s.frame_prompt ?? ''}
                        disabled={stage !== null || redoing !== null}
                        onChange={(e) => setPromptDraft((d) => ({ ...d, [s.id]: e.target.value }))}
                      />
                    </details>
                    <details>
                      <summary className="empty">Motion prompt</summary>
                      {/* What the video model is actually given. Editable for the
                          same reason the frame prompt is: a clip that moves wrongly
                          is fixed by changing what was asked for, and reading it
                          without being able to change it just moves the work
                          somewhere else. Render clip sends whatever is in here. */}
                      <textarea
                        className="prompt-editor"
                        rows={3}
                        value={motionDraft[s.id] ?? s.motion_prompt ?? ''}
                        disabled={stage !== null || clipping !== null}
                        onChange={(e) => setMotionDraft((d) => ({ ...d, [s.id]: e.target.value }))}
                      />
                    </details>
                    {/* Read-only here. Cameras are placed in the Camera tab,
                        where the whole scene can be seen at once - coverage
                        cannot be judged one table row at a time. */}
                    <ShotCameraBadge shotId={s.id} />
                  </td>
                  <td className="col-status">
                    {/* The shot's own state first - it is what this column is
                        for and what you read down the page. The continuity
                        verdict sits under it; it used to trail the Fix button,
                        where "framed" read as debris beside a button. */}
                    <div>{s.status}</div>
                    {s.review_state && s.review_state !== 'ok' && (
                      <div className="review-flag">
                        <span className="badge unresolved">{s.review_state.replace(/_/g, ' ')}</span>
                        <p className="empty">{s.review_note}</p>
                        {/* needs_shot has no re-render that fixes it - the
                            moment is missing from the script, not from the
                            picture. */}
                        {/* The remedy buttons live beside the picture now. */}

                      </div>
                    )}
                  </td>
                </tr>
                </Fragment>
              ))}
            </tbody>
          </table>
        </>
      )}

      {/* The Gallery used to live here - a second grid of the same shots, with
          the thumbnail, the editable prompt and the redo button in it. That
          meant scrolling between a prompt and the picture it produced, which
          are the two things you compare. They are columns of the shot list now,
          so one row is one shot and everything about it. */}

      <h4>3. Produce</h4>
      <div className="upload-form">
        {/* By the # column in the shot list. 0 at either end means "open", so
            0 and 0 is everything, and 5 and 9 is shots 5 to 9. */}
        <label className="range-num" title="First shot # to work on. 0 = from the beginning.">
          Shots from #
          <input
            type="number"
            min={0}
            max={999}
            step={1}
            value={fromPos}
            disabled={stage !== null}
            onChange={(e) => setFromPos(Math.max(0, Number(e.target.value) || 0))}
          />
        </label>
        <label className="range-num" title="Last shot # to work on. 0 = to the end.">
          to #
          <input
            type="number"
            min={0}
            max={999}
            step={1}
            value={toPos}
            disabled={stage !== null}
            onChange={(e) => setToPos(Math.max(0, Number(e.target.value) || 0))}
          />
        </label>
        <label className="upload-form" title="Applies to the Clips stage and to Context Loop. Both the first shot of a scene and every continued shot honour it.">
          <input
            type="checkbox"
            checked={useSpectrum}
            onChange={(e) => setUseSpectrum(e.target.checked)}
            disabled={stage !== null || drafting}
          />
          <span>Spectrum acceleration</span>
        </label>
        {STAGES.map((st) => (
          <button
            type="button"
            key={st.id}
            disabled={
              (st.id !== 'frames' && st.id !== 'clips' && st.id !== 'assemble' && st.id !== 'review') ||
              !plan ||
              shots.length === 0 ||
              stage !== null ||
              drafting ||
              (st.id === 'clips' && framed === 0)
            }
            title={
              st.id === 'frames'
                ? 'Generates a first frame for every shot that does not have one yet'
                : st.id === 'clips'
                  ? 'Renders a MiniMax clip per shot. A shot marked "continue" carries the previous clip\'s picture and sound forward instead of starting from a still.'
                  : st.id === 'review'
                    ? 'Reads every first frame and compares each shot with its neighbour, in text and in picture. Finds props and costumes that do not match their reference, things that swap sides between shots, and moves that were never shown. Flags only - it changes nothing.'
                    : st.id === 'assemble'
                    ? 'Joins every clip rendered for this plan into one cut, in shot order. No GPU time - it stitches what is already on disk, so run it again after any redo.'
                    : 'Not wired yet'
            }
            onClick={
              st.id === 'frames'
                ? runFrames
                : st.id === 'clips'
                  ? runClips
                  : st.id === 'assemble'
                    ? runAssemble
                    : st.id === 'review'
                      ? runReview
                      : undefined
            }
          >
            {st.label} · {stageDone[st.id]}
          </button>
        ))}
        {/* The other route: their chain carries picture AND sound from the
            previous scene, where our clip stage starts each shot from a still. */}
        {/* Also here, beside the other stages. The copy at the top of the shot
            list is where you SEE the marks; this one is where you work through
            the stages in order. Same handler, same count. */}
        {flagged.length > 0 && (
          <button
            type="button"
            disabled={stage !== null || drafting}
            title="Re-renders every frame the review flagged, each with the correction it wrote, then checks the new pictures."
            onClick={fixAllFrames}
          >
            {stage === 'fixing'
              ? `Redoing… ${progress ? `${progress.done} of ${progress.total}` : ''}`
              : `Redo ${flagged.length} flagged frame${flagged.length === 1 ? '' : 's'}`}
          </button>
        )}
        {flagged.length > 0 && (
          <button
            type="button"
            disabled={stage !== null || drafting}
            title="Repairs, re-checks and repeats until nothing is flagged. Stops on its own when two passes make no progress - what is left then needs a shot inserted, not a redo. Press Stop to end it early."
            onClick={fixUntilClean}
          >
            Redo until clean
          </button>
        )}
        {gaps.length > 0 && (
          <button
            type="button"
            disabled={stage !== null || drafting}
            title="Inserts the shot the review wrote for each gap, back to front so the positions stay right. Read one with the row button first if you want to see what it says."
            onClick={insertAllGaps}
          >
            {stage === 'inserting'
              ? `Inserting… ${progress ? `${progress.done} of ${progress.total}` : ''}`
              : `Add ${gaps.length} missing shot${gaps.length === 1 ? '' : 's'}`}
          </button>
        )}
        <button
          type="button"
          disabled={!plan || shots.length === 0 || stage !== null || drafting}
          title="Renders through the MiniMax H3 Context Loop chain: one scene per call, each carrying the previous scene's picture and sound forward"
          onClick={runContextLoop}
        >
          Render via Context Loop
        </button>
        {stage !== null && (
          <button type="button" className="danger" onClick={stopEverything}>
            Stop now
          </button>
        )}
        {stage !== null && (
          <button type="button" onClick={() => (stopRef.current = true)}>
            Stop after this one
          </button>
        )}
      </div>
      {progress ? (
        <p className="empty">
          Frame {Math.min(progress.done + 1, progress.total)} of {progress.total} — {progress.label}. Each takes
          a couple of minutes; leave the tab open. Pressing First frames again resumes where it stopped.
        </p>
      ) : (
        <p className="empty">
          First frames and Clips: one Image Edit render per shot at {FRAME_W}×{FRAME_H}, then one MiniMax
          render each, both skipping shots that already have one. A shot marked <em>continue</em> carries
          the previous clip's picture <em>and sound</em> forward; the rest start from their own frame.
          Assemble joins every clip rendered through Context Loop into one cut and costs no GPU time, so
          run it again after any redo. Review and checks are not built yet.
        </p>
      )}
    </div>
  )
}
