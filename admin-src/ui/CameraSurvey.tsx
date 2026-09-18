import { useEffect, useState } from 'react'
import { insforge, comfyViewUrl, type Movie } from '../insforge'
import { triggerFlow, parseFlowJson } from '../flowise'
import type { FloorPlan } from './ShotCamera'

/**
 * The scene's room, measured — and its landmarks named by a person.
 *
 * NAMING IS DELIBERATELY MANUAL. Two attempts at matching landmarks
 * automatically scored 0.42 and 0.18–0.41 against the wrong pictures, and both
 * times the answer came from looking at the sweep anyway. A person clicking
 * "that's the door" is right in ten seconds and cannot be subtly wrong, which
 * matters because every camera in the scene resolves against these names.
 *
 * The survey itself is automatic: it sweeps the splat, measures where the walls
 * are in every direction, and writes a floor plan. Only the meaning is human.
 */

type Bearing = { bearing_deg: number; image: string; wall_distance: number | null }

type Plan = FloorPlan & {
  created_at: string
  ply_path: string
  survey: { bearings?: Bearing[]; step_deg?: number; gaussians?: number }
}

// What a scene usually contains. Free text is still allowed - these are the
// names the shot list will use, so they have to match what a director says.
const SUGGESTED = ['desk', 'door', 'window', 'fire', 'bed', 'stairs', 'stage', 'bar', 'table']

export function CameraSurvey({
  movie,
  act,
  scene,
  directorPlanId,
  onPlan
}: {
  movie: Movie
  act: number
  scene: number
  directorPlanId: string | null
  onPlan?: (plan: FloorPlan | null) => void
}) {
  const [plan, setPlan] = useState<Plan | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [naming, setNaming] = useState<number | null>(null)
  const [typed, setTyped] = useState('')

  async function load() {
    const { data } = await insforge.database
      .from('scene_floor_plans')
      .select('*')
      .eq('movie_id', movie.id)
      .eq('act_number', act)
      .eq('scene_number', scene)
      .order('created_at', { ascending: false })
      .limit(1)
    const p = ((data ?? []) as Plan[])[0] ?? null
    setPlan(p)
    if (onPlan) onPlan(p)
  }

  useEffect(() => {
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [movie.id, act, scene])

  async function call(mode: string, body: Record<string, unknown>, label: string) {
    const flowId = import.meta.env.VITE_SPLAT_CAMERA_ID
    if (!flowId) {
      setNote('VITE_SPLAT_CAMERA_ID is not set — restart the dev server after adding it.')
      return null
    }
    setBusy(label)
    setNote(null)
    const res = parseFlowJson<{ action: string; reason?: string; planId?: string; log?: string }>(
      await triggerFlow(flowId, { mode, ...body })
    )
    setBusy(null)
    if (!res.ok) {
      setNote(res.message)
      return null
    }
    if (res.data.action === 'error') {
      // The tool exits with a sentence about what to do next, not a stack.
      setNote(res.data.reason ?? 'The camera tool failed.')
      return null
    }
    await load()
    return res.data
  }

  const marks = plan?.landmarks ?? {}
  const named = Object.entries(marks)
  const bearings = plan?.survey?.bearings ?? []

  /** Give one swept bearing a name. This is the whole manual step. */
  async function nameIt(deg: number, name: string) {
    const clean = name.trim().toLowerCase()
    if (!clean || !plan) return
    setNaming(null)
    setTyped('')
    await call(
      'landmarks',
      {
        planId: plan.id,
        set: { [clean]: deg },
        // A landmark in the middle of the room is a position, not a direction -
        // a camera standing on it cannot see it at any bearing.
        center: clean === 'desk' || clean === 'table' || clean === 'bed' ? [clean] : []
      },
      `naming ${clean}`
    )
  }

  return (
    <div className="camera-survey">
      <h4>Camera — A{act}S{scene}</h4>

      {!plan && (
        <p className="empty">
          No floor plan yet. Surveying sweeps this scene's splat, measures where the walls are in
          every direction, and works out the room's radius — so camera distances can be expressed
          as fractions of the room and mean the same thing after a rebuild.
        </p>
      )}

      <div className="upload-form">
        <button type="button" disabled={busy !== null} onClick={() => call('survey', { movieId: movie.id, act, scene }, 'survey')}>
          {busy === 'survey' ? 'Surveying…' : plan ? 'Re-survey' : 'Survey the room'}
        </button>
        {plan && directorPlanId && (
          <button
            type="button"
            disabled={busy !== null || named.length === 0}
            title={named.length ? undefined : 'Name at least one landmark first'}
            onClick={() =>
              call('seed', {
                directorPlanId,
                scene,
                lookAt: named[0]?.[0] ?? 'desk',
                lineSide: named.find(([n]) => n !== named[0]?.[0])?.[0]
              }, 'seed')
            }
          >
            {busy === 'seed' ? 'Seeding…' : 'Seed cameras for every shot'}
          </button>
        )}
        {plan && named.length > 0 && (
          <button type="button" disabled={busy !== null} onClick={() => call('render', { planId: plan.id }, 'render')}>
            {busy === 'render' ? 'Rendering…' : 'Render every plate'}
          </button>
        )}
      </div>

      {plan && (
        <p className="empty">
          {plan.world_name} · room radius {plan.room_radius.toFixed(2)} ·{' '}
          {plan.survey?.gaussians?.toLocaleString() ?? '?'} gaussians ·{' '}
          {named.length ? `named: ${named.map(([n]) => n).join(', ')}` : 'no landmarks named yet'}
        </p>
      )}

      {note && <p className="error">{note}</p>}

      {plan && bearings.length > 0 && (
        <>
          <p className="empty">
            Click a view to say what it is looking at. Those names are what every camera in this
            scene points at, so they should be the words the shot list uses.
          </p>
          <div className="survey-grid">
            {bearings.map((b) => {
              const mine = named.find(([, m]) => m.bearing_deg === b.bearing_deg)
              return (
                <div key={b.bearing_deg} className={mine ? 'survey-view named' : 'survey-view'}>
                  <img
                    src={comfyViewUrl(b.image, plan.id)}
                    alt={`${b.bearing_deg} degrees`}
                    onClick={() => setNaming(naming === b.bearing_deg ? null : b.bearing_deg)}
                  />
                  <span className="empty">
                    {b.bearing_deg}° {b.wall_distance ? `· wall ${b.wall_distance.toFixed(1)}` : ''}
                    {mine ? ` · ${mine[0]}` : ''}
                  </span>
                  {naming === b.bearing_deg && (
                    <div className="survey-name">
                      {SUGGESTED.map((s) => (
                        <button key={s} type="button" disabled={busy !== null} onClick={() => nameIt(b.bearing_deg, s)}>
                          {s}
                        </button>
                      ))}
                      <input
                        type="text"
                        placeholder="or type one"
                        value={typed}
                        onChange={(e) => setTyped(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') nameIt(b.bearing_deg, typed)
                        }}
                      />
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        </>
      )}
    </div>
  )
}
