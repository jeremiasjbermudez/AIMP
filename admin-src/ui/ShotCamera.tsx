import { useEffect, useRef, useState } from 'react'
import { insforge, comfyViewUrl, type Movie } from '../insforge'
import { CLEANED_PLATE_LABEL } from '../frames'
import { triggerFlow, parseFlowJson } from '../flowise'
import { Select } from './Select'
import {
  translateIntent, elevateIntent, elevationOf,
  type Plan, type Intent
} from '../cameraIntent'

/**
 * Where the camera stands for one shot, inside the scene's 3D world.
 *
 * WHY THIS IS NOT THREE NUMBERS AND A LENS. Every reconstruction sets its own
 * origin, axes and scale - the two builds of a location differ by about 5x -
 * so a stored coordinate points somewhere else the moment a world is rebuilt,
 * while still looking like a valid camera. What is stored instead is what a
 * director would say: look at the desk, stand back 0.38 of the room, 45mm, on
 * the fire side of the line. That re-resolves against any build of the room.
 *
 * Everything here is a fraction of the room's own measured radius, so the same
 * numbers mean the same shot in any world.
 */

/**
 * A measured room, plus which build it was measured in.
 *
 * Extends the maths module's Plan rather than restating it, so the fields the
 * camera resolver reads - centre, up, facing, radius, landmark directions and
 * wall distances - cannot be quietly dropped from the query and leave the
 * arithmetic running on zeroes.
 */
export type FloorPlan = Plan & {
  id: string
  world_name: string
  ply_path: string
}

type Camera = {
  id: string
  shot_id: string
  label: string | null
  is_chosen: boolean
  from_landmark: string | null
  look_at_landmark: string
  distance_frac: number
  offset_frac: number
  eye_height_frac: number
  aim_height_frac: number
  aim_side_frac: number
  fov_deg: number
  line_side_landmark: string | null
  explicit_world: string | null
  is_manual: boolean
}

type Plate = {
  id: string
  floor_plan_id: string
  image_path: string | null
  resolved_fov: number | null
  created_at: string
}

const round4 = (x: number) => Math.round(x * 10000) / 10000

/**
 * One control, committed on release.
 *
 * A range input fires on every pixel of a drag, and every change here costs a
 * render - so the handle moves live and the shot is only re-rendered when the
 * handle is let go. Dragging would otherwise queue dozens of renders of framings
 * nobody asked to see.
 */
function Move({
  label, min, max, step, value, disabled, format, onCommit
}: {
  label: string
  min: number
  max: number
  step: number
  value: number
  disabled?: boolean
  format: (v: number) => string
  onCommit: (v: number) => void
}) {
  const [v, setV] = useState(value)
  // Follow the shot when it changes underneath - another control, or a re-seed.
  useEffect(() => setV(value), [value])

  /**
   * One step, committed at once.
   *
   * Rounded before use: adding 0.01 to a float repeatedly drifts, and a shot
   * reading 0.30000000000000004 in the fields would be the arrows' fault.
   */
  function bump(direction: number) {
    const next = Math.min(max, Math.max(min, Number((v + direction * step).toFixed(6))))
    if (next === v) return
    setV(next)
    onCommit(next)
  }

  return (
    <label className="move">
      <span className="move-name">{label}</span>
      <button type="button" className="move-step" disabled={disabled} onClick={() => bump(-1)}
        title={`${label} down one step`}>◂</button>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={v}
        disabled={disabled}
        onChange={(e) => setV(Number(e.target.value))}
        onPointerUp={() => onCommit(v)}
        onTouchEnd={() => onCommit(v)}
        onKeyUp={() => onCommit(v)}
      />
      <button type="button" className="move-step" disabled={disabled} onClick={() => bump(1)}
        title={`${label} up one step`}>▸</button>
      <span className="move-value">{format(v)}</span>
    </label>
  )
}

export function ShotCamera({
  shotId,
  position,
  plan,
  onPlate,
  movie,
  act,
  scene,
  directorPlanId
}: {
  shotId: string
  position: number
  plan: FloorPlan | null
  /** The shot list this shot belongs to - Sharpen needs it to find the shot. */
  directorPlanId?: string | null
  /**
   * For Clean up. The cleanup flow needs the movie and the scene so it can
   * take the scene's panorama as the clean reference the plate is corrected
   * against; without these the button is not offered.
   */
  movie?: Movie
  act?: number
  scene?: number
  /** Told when a new plate lands, so the shot can be re-rendered against it. */
  onPlate?: (imagePath: string) => void
}) {
  const [camera, setCamera] = useState<Camera | null>(null)
  const [plate, setPlate] = useState<Plate | null>(null)
  const [busy, setBusy] = useState(false)
  // Framing at thumbnail size is guesswork, so the whole control surface can
  // take over the window - same controls, same handlers, just big enough to
  // judge a shot by.
  const [big, setBig] = useState(false)
  // Clean up: run the plate through an image model and make the result the
  // shot's plate. Qwen is the purpose-built cleanup (the ugly render is its
  // canvas, the scene's panorama its reference); Flux is the Image Edit flow,
  // which is freer with the room. The prompt is the operator's, verbatim.
  const [engine, setEngine] = useState<'qwen' | 'flux'>('qwen')
  const [cleanPrompt, setCleanPrompt] = useState('hyper realistic, 4k')
  const [cleaning, setCleaning] = useState(false)
  const [cleaned, setCleaned] = useState<string | null>(null)
  // Sharpen: teach the world to be detailed at THIS angle. It writes a camera
  // path through this shot, renders it, then continues the world's training
  // from its last checkpoint with that path expanded. Long, and it changes the
  // world every shot of this scene renders from, so it asks first.
  const [sharpening, setSharpening] = useState<'idle' | 'confirm' | 'running'>('idle')
  const [sharpenNote, setSharpenNote] = useState<string | null>(null)
  // Dragging on the plate. Held in a ref rather than state because it changes
  // on every pointer event and none of it belongs in a render.
  const drag = useRef<{ x: number; y: number; start: Intent; mode: 'orbit' | 'aim' | 'slide' } | null>(null)
  const wheelTimer = useRef<number | null>(null)
  const [note, setNote] = useState<string | null>(null)

  async function load() {
    const { data: cams } = await insforge.database
      .from('shot_cameras')
      .select('*')
      .eq('shot_id', shotId)
      .eq('is_chosen', true)
      .limit(1)
    const cam = ((cams ?? []) as Camera[])[0] ?? null
    setCamera(cam)
    if (!cam) return setPlate(null)
    const { data: plates } = await insforge.database
      .from('camera_plates')
      .select('id,floor_plan_id,image_path,resolved_fov,created_at')
      .eq('shot_camera_id', cam.id)
      .order('created_at', { ascending: false })
      .limit(1)
    setPlate(((plates ?? []) as Plate[])[0] ?? null)
  }

  useEffect(() => {
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shotId, plan?.id])

  useEffect(() => {
    if (!big) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setBig(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [big])

  /**
   * Write one field and re-render.
   *
   * `is_manual` goes true on any edit here. A re-seed refreshes computed
   * cameras; it must never quietly overwrite one that a person has tuned.
   */
  async function change(patch: Partial<Camera>): Promise<boolean> {
    if (!camera) return false
    const previous = camera
    setCamera({ ...camera, ...patch } as Camera)
    const { error } = await insforge.database
      .from('shot_cameras')
      .update({ ...patch, is_manual: true, updated_at: new Date().toISOString() })
      .eq('id', camera.id)
    if (error) {
      // Put the controls back to what the database actually holds. Showing a
      // number that was never written is worse than showing the old one - it
      // reads as saved, and the next plate comes back as a different shot.
      setCamera(previous)
      setNote(error.message)
      return false
    }
    setNote(null)
    return true
  }

  /** What this camera currently is, in the shape the maths speaks. */
  function intentOf(cam: Camera): Intent {
    return {
      look_at_landmark: cam.look_at_landmark,
      from_landmark: cam.from_landmark,
      line_side_landmark: cam.line_side_landmark,
      distance_frac: cam.distance_frac,
      offset_frac: cam.offset_frac,
      eye_height_frac: cam.eye_height_frac,
      aim_height_frac: cam.aim_height_frac,
      aim_side_frac: cam.aim_side_frac ?? 0,
      fov_deg: cam.fov_deg
    }
  }

  /**
   * Change the shot and show the result.
   *
   * Saved first, then rendered, because the renderer reads the row rather than
   * taking a payload - so an unsaved change would render the previous framing
   * and look like the control did nothing.
   */
  /**
   * Clean up the plate.
   *
   * The raw render stays on record in camera_plates; the cleaned picture
   * becomes the shot's plate_path, which is what the frame generator and the
   * picker read. Qwen goes through the same job row and flow as the Qwen
   * Cleanup tab, so its results sit in that tab's history too.
   */
  async function cleanUp() {
    if (!movie || !plate?.image_path || cleaning) return
    setCleaning(true)
    setNote(null)
    try {
      let out: string | null = null
      if (engine === 'qwen') {
        const flowId = import.meta.env.VITE_QWEN_CLEANUP_ID
        if (!flowId) throw new Error('VITE_QWEN_CLEANUP_ID is not set.')
        const { data, error } = await insforge.database
          .from('qwen_cleanups')
          .insert([{
            movie_id: movie.id,
            act_number: act ?? null,
            scene_number: scene ?? null,
            source_image_path: plate.image_path,
            reference_image_path: null,
            prompt: cleanPrompt.trim(),
            status: 'queued'
          }])
          .select()
        if (error) throw new Error(error.message)
        const job = ((data ?? []) as { id: string }[])[0]
        if (!job) throw new Error('The cleanup job was not created.')
        const res = parseFlowJson<{ action?: string; reason?: string; error?: string }>(
          await triggerFlow(flowId, { cleanupId: job.id })
        )
        if (!res.ok) throw new Error(res.message)
        if (res.data.error || res.data.action === 'error') throw new Error(res.data.error ?? res.data.reason ?? 'Cleanup failed.')
        const { data: done } = await insforge.database
          .from('qwen_cleanups')
          .select('cleaned_image_path,status,error_message')
          .eq('id', job.id)
          .limit(1)
        const row = ((done ?? []) as { cleaned_image_path: string | null; status: string; error_message: string | null }[])[0]
        if (!row?.cleaned_image_path) throw new Error(row?.error_message ?? `Cleanup ended with status ${row?.status ?? 'unknown'} and no image.`)
        out = row.cleaned_image_path
      } else {
        const flowId = import.meta.env.VITE_IMAGE_EDIT_ID
        if (!flowId) throw new Error('VITE_IMAGE_EDIT_ID is not set.')
        const res = parseFlowJson<{ outputPath?: string; error?: string }>(
          await triggerFlow(flowId, {
            movieId: movie.id,
            prompt: cleanPrompt.trim(),
            references: [{ path: plate.image_path, label: 'the location' }],
            width: 1344,
            height: 768,
            steps: 8
          })
        )
        if (!res.ok) throw new Error(res.message)
        if (!res.data.outputPath) throw new Error(res.data.error ?? 'The edit returned no image.')
        out = res.data.outputPath
      }
      setCleaned(out)
      // The cleaned picture is now what this shot stands on.
      if (onPlate) await onPlate(out)
      // And it is kept as its own entry in every image picker ("Cleaned plates"),
      // so going back to the raw plate later does not lose it.
      const { error: keepError } = await insforge.database.from('movie_frames').insert([{
        movie_id: movie.id,
        source_label: `${CLEANED_PLATE_LABEL} · S${scene ?? '?'} shot ${position} · ${engine}`,
        frame_number: null,
        image_path: out
      }])
      if (keepError) setNote(`Cleaned, but it could not be listed for the pickers: ${keepError.message}`)
    } catch (e) {
      setNote(e instanceof Error ? e.message : String(e))
    } finally {
      setCleaning(false)
    }
  }

  /**
   * Sharpen this angle.
   *
   * Two steps, both long. First the camera path: an arc through this shot's
   * camera, written where the world builder's own planner writes its paths and
   * rendered the same way, so the builder treats it as one more trajectory.
   * Then the build, with --resume: WorldStereo invents close views along that
   * path and training continues from the last checkpoint rather than starting
   * over, which is what keeps this to about half an hour instead of a day.
   *
   * Everything already computed is kept: other trajectories are reused from
   * their folders, and the previous .ply is backed up, never overwritten in
   * place. The World tab's splat picker can switch back to it.
   */
  async function sharpen() {
    if (!plan || !directorPlanId || act == null || scene == null) return
    setSharpening('running')
    setSharpenNote('Writing and rendering the camera path…')
    try {
      const traj = parseFlowJson<{ action?: string; reason?: string; log?: string }>(
        await triggerFlow(import.meta.env.VITE_SPLAT_CAMERA_ID, {
          mode: 'sharpen',
          planId: plan.id,
          directorPlanId,
          shot: position
        })
      )
      if (!traj.ok) throw new Error(traj.message)
      if (traj.data.action === 'error') throw new Error(traj.data.reason ?? 'The camera path could not be written.')

      setSharpenNote('Path ready. Continuing the world from its last checkpoint — this takes about half an hour. You can leave this tab.')
      const flags = `A${act}S${scene} --resume --workspace ${plan.world_name} --max-traj 0 --steps 2001`
      const build = parseFlowJson<{ action?: string; reason?: string; plyPath?: string }>(
        await triggerFlow(import.meta.env.VITE_WORLD_BUILDER_ID, flags)
      )
      if (!build.ok) throw new Error(build.message)
      if (build.data.action === 'error') throw new Error(build.data.reason ?? 'The build failed.')
      if (build.data.action === 'pending') {
        setSharpenNote('Still building past the flow\'s wait. It continues on the server; check the World tab for the new splat.')
      } else {
        setSharpenNote('Sharpened. Re-render this plate to see it. The previous world is still listed in the World tab.')
      }
    } catch (e) {
      setSharpenNote(e instanceof Error ? e.message : String(e))
    } finally {
      setSharpening('idle')
    }
  }

  /** A typed field edit: save it, then show it. */
  async function apply(patch: Partial<Camera>) {
    if (await change(patch)) await rerender()
  }

  async function nudge(move: (i: Intent) => Intent) {
    if (!camera || busy) return
    if (await change(move(intentOf(camera)))) await rerender()
  }

  /**
   * Move the camera by dragging the picture.
   *
   * The plate is the viewfinder, so it should be grabbable like one. Dragging
   * walks the camera around the subject and raises or lowers it; holding shift
   * swings where it points instead; the wheel moves in and out.
   *
   * Nothing is written while the pointer is down - the sliders follow live off
   * local state, and the shot is saved and re-rendered once, on release. A
   * render per pixel of a drag would be unusable and would queue dozens of
   * framings nobody asked to see.
   */
  function dragStart(e: React.PointerEvent<HTMLDivElement>) {
    if (!camera || !plan || busy) return
    e.currentTarget.setPointerCapture(e.pointerId)
    // Right button slides the camera, the way it does in the splat viewer.
    const mode = e.button === 2 || e.button === 1 ? 'slide' : e.shiftKey ? 'aim' : 'orbit'
    drag.current = { x: e.clientX, y: e.clientY, start: intentOf(camera), mode }
  }

  function dragMove(e: React.PointerEvent<HTMLDivElement>) {
    const d = drag.current
    if (!d || !camera) return
    const dx = e.clientX - d.x
    const dy = e.clientY - d.y
    if (d.mode === 'aim') {
      // Swing the aim: drag right to look right, drag up to look up.
      setCamera({
        ...camera,
        aim_side_frac: round4(d.start.aim_side_frac + dx * 0.0012),
        aim_height_frac: round4(d.start.aim_height_frac - dy * 0.0012)
      } as Camera)
      return
    }
    if (d.mode === 'slide') {
      // Straight across and straight up, no turning.
      if (!plan) return
      const moved = translateIntent(d.start, plan, -dx * 0.0016, dy * 0.0016)
      setCamera({
        ...camera,
        distance_frac: round4(moved.distance_frac),
        offset_frac: round4(moved.offset_frac),
        aim_side_frac: round4(moved.aim_side_frac),
        eye_height_frac: round4(moved.eye_height_frac),
        aim_height_frac: round4(moved.aim_height_frac)
      } as Camera)
      return
    }
    // Walk around the subject, and up or down. Orbit is the pair of stored
    // numbers in polar form, so a horizontal drag is just a change of bearing.
    const r = Math.max(0.03, Math.hypot(d.start.distance_frac, d.start.offset_frac))
    const t = Math.atan2(d.start.offset_frac, d.start.distance_frac) + dx * 0.006
    // Round the subject, then up over it - the two halves of orbit.
    const arced = elevateIntent(
      { ...d.start, distance_frac: r * Math.cos(t), offset_frac: r * Math.sin(t) },
      -dy * 0.22
    )
    setCamera({
      ...camera,
      distance_frac: round4(arced.distance_frac),
      offset_frac: round4(arced.offset_frac),
      eye_height_frac: round4(arced.eye_height_frac)
    } as Camera)
  }

  async function dragEnd() {
    if (!drag.current || !camera) return
    drag.current = null
    if (await change(intentOf(camera))) await rerender()
  }

  /** Wheel to move in and out, rendered once the wheel stops. */
  function dragWheel(e: React.WheelEvent<HTMLDivElement>) {
    if (!camera || !plan || busy) return
    const k = e.deltaY > 0 ? 1.12 : 1 / 1.12
    const r = Math.hypot(camera.distance_frac, camera.offset_frac)
    const scale = r < 1e-6 ? 1 : Math.max(0.03 / r, k)
    const next = {
      ...camera,
      distance_frac: round4(camera.distance_frac * scale),
      offset_frac: round4(camera.offset_frac * scale)
    } as Camera
    setCamera(next)
    if (wheelTimer.current) window.clearTimeout(wheelTimer.current)
    wheelTimer.current = window.setTimeout(async () => {
      wheelTimer.current = null
      if (await change(intentOf(next))) await rerender()
    }, 450)
  }

  async function rerender() {
    if (!plan) return setNote('This scene has no floor plan yet — survey it first.')
    const flowId = import.meta.env.VITE_SPLAT_CAMERA_ID
    if (!flowId) return setNote('VITE_SPLAT_CAMERA_ID is not set — restart the dev server after adding it.')
    setBusy(true)
    setNote(null)
    const res = parseFlowJson<{ action: string; reason?: string; log?: string }>(
      await triggerFlow(flowId, { mode: 'render', planId: plan.id, shot: position })
    )
    setBusy(false)
    if (!res.ok) return setNote(res.message)
    if (res.data.action === 'error') return setNote(res.data.reason ?? 'The render failed.')
    await load()
    const { data } = await insforge.database
      .from('camera_plates')
      .select('image_path')
      .eq('shot_camera_id', camera?.id ?? '')
      .order('created_at', { ascending: false })
      .limit(1)
    const made = ((data ?? []) as { image_path: string }[])[0]
    if (made?.image_path && onPlate) onPlate(made.image_path)
  }

  if (!camera) {
    return (
      <details className="shot-camera">
        <summary className="empty">Camera — none</summary>
        <p className="empty">
          This shot has no camera in the scene's world yet. Seed the scene's cameras from the
          camera panel above.
        </p>
      </details>
    )
  }

  const marks = Object.keys(plan?.landmarks ?? {})
  const items = marks.map((m) => ({ value: m, label: m }))
  // A plate made against an older plan is stale by definition: the world it was
  // rendered in has been rebuilt since, so the background no longer matches the
  // room every other shot is in.
  const stale = !!plate && !!plan && plate.floor_plan_id !== plan.id
  const stranded = !!camera.explicit_world && camera.explicit_world !== plan?.world_name

  return (
    <details className="shot-camera">
      <summary className="empty">
        Camera — {camera.look_at_landmark} · {camera.distance_frac.toFixed(2)}× · {Math.round(camera.fov_deg)}°
        {camera.is_manual ? ' · tuned' : ''}
        {stale ? ' · PLATE STALE' : ''}
        {stranded ? ' · STRANDED' : ''}
      </summary>

      {stranded && (
        <p className="error">
          This camera is pinned to the world <strong>{camera.explicit_world}</strong>, which is not the
          one this scene now uses. A hand-flown angle cannot be re-derived in a different
          reconstruction — clear the pin, or rebuild against that world.
        </p>
      )}
      {stale && !stranded && (
        <p className="empty">
          The plate below was rendered against an earlier build of this room. Re-render to bring it
          back in line with everything else.
        </p>
      )}

      <details className="camera-numbers">
        <summary className="empty">Numbers</summary>
      <div className="upload-form">
        <label className="empty">
          Looking at
          <Select
            value={camera.look_at_landmark}
            onValueChange={(v) => apply({ look_at_landmark: v })}
            items={items}
            placeholder={marks.length ? 'pick a landmark' : 'name the landmarks first'}
          />
        </label>
        <label className="empty">
          Standing toward
          <Select
            value={camera.from_landmark ?? ''}
            onValueChange={(v) => apply({ from_landmark: v || null })}
            items={[{ value: '', label: 'the room’s centre' }, ...items]}
          />
        </label>
        <label className="empty">
          Side of the line
          <Select
            value={camera.line_side_landmark ?? ''}
            onValueChange={(v) => apply({ line_side_landmark: v || null })}
            items={[{ value: '', label: 'either' }, ...items]}
          />
        </label>
      </div>

      <div className="upload-form">
        {/* Everything as a fraction of the room's radius, so it means the same
            shot in any build of the room. */}
        <label className="empty">
          Distance ×radius
          <input
            type="number" step="0.01" min="0.02" max="2" size={5}
            value={camera.distance_frac}
            onChange={(e) => apply({ distance_frac: Number(e.target.value) })}
          />
        </label>
        <label className="empty">
          Sideways
          <input
            type="number" step="0.01" min="-1" max="1" size={5}
            value={camera.offset_frac}
            onChange={(e) => apply({ offset_frac: Number(e.target.value) })}
          />
        </label>
        <label className="empty">
          Camera height
          <input
            type="number" step="0.01" min="-0.5" max="1" size={5}
            value={camera.eye_height_frac}
            onChange={(e) => apply({ eye_height_frac: Number(e.target.value) })}
          />
        </label>
        <label className="empty" title="What the camera points at, above the floor plan's centre. The centre of a room is a desk surface, not a face.">
          Aim height
          <input
            type="number" step="0.01" min="-0.5" max="1" size={5}
            value={camera.aim_height_frac}
            onChange={(e) => apply({ aim_height_frac: Number(e.target.value) })}
          />
        </label>
        <label className="empty" title="How far to one side of the landmark the camera aims. This is what lets a shot look BETWEEN two named things instead of only straight at one.">
          Aim sideways
          <input
            type="number" step="0.01" min="-1.5" max="1.5" size={5}
            value={camera.aim_side_frac ?? 0}
            onChange={(e) => apply({ aim_side_frac: Number(e.target.value) })}
          />
        </label>
        <label className="empty">
          Lens °
          <input
            type="number" step="1" min="10" max="150" size={5}
            value={camera.fov_deg}
            onChange={(e) => apply({ fov_deg: Number(e.target.value) })}
          />
        </label>
      </div>
      </details>

      {note && <p className="error">{note}</p>}

      <div className="upload-form">
        <button type="button" onClick={() => setBig((v) => !v)}>
          {big ? 'Done framing' : 'Bigger'}
        </button>
      </div>

      {plan && directorPlanId && act != null && scene != null && (
        <div className="upload-form clean-up">
          {sharpening === 'confirm' ? (
            <>
              <span className="empty">
                Rebuilds this scene's world around this angle: about half an hour, and every shot in
                the scene will then render from the new one. The current world is kept and can be
                switched back to in the World tab.
              </span>
              <button type="button" onClick={sharpen}>
                Yes, sharpen
              </button>
              <button type="button" onClick={() => setSharpening('idle')}>
                Cancel
              </button>
            </>
          ) : (
            <button
              type="button"
              disabled={sharpening === 'running' || busy || cleaning}
              title="Teach the world to be detailed at this angle"
              onClick={() => setSharpening('confirm')}
            >
              {sharpening === 'running' ? 'Sharpening…' : 'Sharpen this angle'}
            </button>
          )}
          {sharpenNote && <span className="empty">{sharpenNote}</span>}
        </div>
      )}

      {movie && (
        <div className="upload-form clean-up">
          <label className="empty">
            Clean up with
            <Select
              value={engine}
              onValueChange={(v) => setEngine(v === 'flux' ? 'flux' : 'qwen')}
              items={[
                { value: 'qwen', label: 'Qwen (cleanup — keeps the room)' },
                { value: 'flux', label: 'Flux (image edit — freer)' }
              ]}
            />
          </label>
          <label className="empty">
            Prompt
            <input type="text" value={cleanPrompt} onChange={(e) => setCleanPrompt(e.target.value)} size={22} />
          </label>
          <button type="button" disabled={cleaning || busy || !plate?.image_path} onClick={cleanUp}>
            {cleaning ? 'Cleaning up…' : 'Clean up'}
          </button>
          {cleaned && (
            <button
              type="button"
              disabled={cleaning || !plate?.image_path}
              title="Point the shot back at the raw splat render"
              onClick={async () => { if (onPlate && plate?.image_path) { await onPlate(plate.image_path); setCleaned(null) } }}
            >
              Back to raw plate
            </button>
          )}
        </div>
      )}

      {cleaned && (
        <figure className="cleaned-plate">
          <img className="edit-output" src={comfyViewUrl(cleaned, String(Date.now()))} alt={`cleaned plate for shot ${position}`} />
          <figcaption className="empty">Cleaned up image — now this shot's plate</figcaption>
        </figure>
      )}

      {/* Everything you frame with, together - so it can all move into a
          full-window layout at once rather than the picture going big and
          leaving its controls behind in the card. */}
      <div className={big ? 'framing framing-big' : 'framing'}>
        {/* The camera head, as sliders.

            Orbit and dolly are the same pair of stored numbers in polar form -
            how far round the subject, and how far back - because that is how a
            camera is actually moved, and nobody thinks in two perpendicular
            fractions. Pan, tilt and zoom are the head itself.

            Every commit re-renders through the same Python renderer that makes the
            final plate, so the picture below is the shot rather than a preview of
            it. */}
        <div className="ptz-sliders">
          <Move
            label="Orbit" min={-180} max={180} step={1} disabled={busy || !plan}
            value={Math.round((Math.atan2(camera.offset_frac, camera.distance_frac) * 180) / Math.PI)}
            format={(v) => `${v}°`}
            onCommit={(deg) => nudge((i) => {
              const r = Math.max(0.03, Math.hypot(i.distance_frac, i.offset_frac))
              const t = (deg * Math.PI) / 180
              return { ...i, distance_frac: round4(r * Math.cos(t)), offset_frac: round4(r * Math.sin(t)) }
            })}
          />
          <Move
            label="Dolly" min={0.05} max={1.5} step={0.01} disabled={busy || !plan}
            value={round4(Math.hypot(camera.distance_frac, camera.offset_frac))}
            format={(v) => `${v.toFixed(2)}×`}
            onCommit={(r) => nudge((i) => {
              const t = Math.atan2(i.offset_frac, i.distance_frac)
              return { ...i, distance_frac: round4(r * Math.cos(t)), offset_frac: round4(r * Math.sin(t)) }
            })}
          />
          <Move
            label="Elevation" min={-85} max={85} step={1} disabled={busy || !plan}
            value={Math.round(elevationOf(intentOf(camera)))}
            format={(v) => `${v}°`}
            onCommit={(deg) => nudge((i) => elevateIntent(i, deg - elevationOf(i)))}
          />
          <Move
            label="Pedestal" min={-0.3} max={0.8} step={0.01} disabled={busy || !plan}
            value={round4(camera.eye_height_frac)}
            format={(v) => v.toFixed(2)}
            onCommit={(h) => nudge((i) => ({ ...i, eye_height_frac: round4(h) }))}
          />
          <Move
            label="Tilt" min={-0.4} max={0.7} step={0.01} disabled={busy || !plan}
            value={round4(camera.aim_height_frac)}
            format={(v) => v.toFixed(2)}
            onCommit={(h) => nudge((i) => ({ ...i, aim_height_frac: round4(h) }))}
          />
          <Move
            label="Pan" min={-0.8} max={0.8} step={0.01} disabled={busy || !plan}
            value={round4(camera.aim_side_frac)}
            format={(v) => v.toFixed(2)}
            onCommit={(x) => nudge((i) => ({ ...i, aim_side_frac: round4(x) }))}
          />
          <Move
            label="Zoom" min={15} max={110} step={1} disabled={busy || !plan}
            value={Math.round(camera.fov_deg)}
            format={(v) => `${v}°`}
            onCommit={(f) => nudge((i) => ({ ...i, fov_deg: f }))}
          />
        </div>



        {busy && <p className="empty">Rendering…</p>}

        {plate?.image_path && (
          <>
            <div
              className="plate-stage"
              onPointerDown={dragStart}
              onPointerMove={dragMove}
              onPointerUp={dragEnd}
              onPointerCancel={dragEnd}
              onWheel={dragWheel}
              onContextMenu={(e) => e.preventDefault()}
            >
              <img
                className="edit-output"
                src={comfyViewUrl(plate.image_path, plate.id)}
                alt={`plate for shot ${position}`}
                draggable={false}
              />
            </div>
            <p className="empty plate-hint">
              {cleaned ? 'Raw splat render (the camera) — ' : ''}Drag to go round · right-drag to slide straight across and up · shift-drag to aim · wheel for in and out
            </p>
          </>
        )}
      </div>

    </details>
  )
}
