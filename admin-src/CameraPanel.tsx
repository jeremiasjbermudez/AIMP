import { useEffect, useState } from 'react'
import { insforge, type Movie, type Scene } from './insforge'
import { Select } from './ui/Select'
import { CameraSurvey } from './ui/CameraSurvey'
import { ShotCamera, type FloorPlan } from './ui/ShotCamera'

/**
 * The tech recce: where every camera in a scene stands, seen together.
 *
 * WHY THIS IS NOT IN THE DIRECTOR TAB. Placing cameras is a different job from
 * shooting. You do a whole scene in one pass and judge it by looking at the
 * angles SIDE BY SIDE - does the reverse match the wide, is anybody on the
 * wrong side of the line, do the three inserts look like the same room. The
 * Director is a list, one shot per row, and coverage cannot be judged down a
 * list. So this is a grid of plates, which is how a scene is actually looked at.
 *
 * The Director keeps a one-line read-only summary of each shot's camera, which
 * is all that is worth knowing while shooting.
 */

type PlanRow = {
  id: string
  created_at: string
  target_seconds: number
  status: string
  /** Shots in this scene on this plan - what the picker shows, and what decides the default. */
  shots: number
}

type Shot = {
  id: string
  position: number
  scene_number: number | null
  shot_type: string
  characters: string[] | null
  frame_prompt: string | null
}

export function CameraPanel({ movie }: { movie: Movie }) {
  const [scenes, setScenes] = useState<Scene[]>([])
  const [scene, setScene] = useState<Scene | null>(null)
  const [shots, setShots] = useState<Shot[]>([])
  const [planId, setPlanId] = useState<string | null>(null)
  const [plans, setPlans] = useState<PlanRow[]>([])
  const [floorPlan, setFloorPlan] = useState<FloorPlan | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    ;(async () => {
      setLoading(true)
      const { data: sc } = await insforge.database
        .from('scenes')
        .select('*')
        .eq('movie_id', movie.id)
        .order('act_number', { ascending: true })
        .order('scene_number', { ascending: true })
      const list = (sc ?? []) as Scene[]
      setScenes(list)
      setScene(list[0] ?? null)

      setLoading(false)
    })()
  }, [movie.id])

  // Every plan for the movie, with how many shots each has in the chosen scene.
  // The default is the newest plan that HAS shots: "newest plan" alone picked
  // an empty draft made by mistake and the tab showed nothing to place.
  useEffect(() => {
    if (!scene) return
    let live = true
    ;(async () => {
      const { data: rows } = await insforge.database
        .from('director_plans')
        .select('id,created_at,target_seconds,status')
        .eq('movie_id', movie.id)
        .order('created_at', { ascending: false })
      const list = (rows ?? []) as Omit<PlanRow, 'shots'>[]
      const { data: counts } = await insforge.database
        .from('director_shots')
        .select('plan_id')
        .eq('movie_id', movie.id)
        .eq('scene_number', scene.scene_number)
      const per: Record<string, number> = {}
      for (const r of (counts ?? []) as { plan_id: string }[]) per[r.plan_id] = (per[r.plan_id] ?? 0) + 1
      const withCounts = list.map((p) => ({ ...p, shots: per[p.id] ?? 0 }))
      if (!live) return
      setPlans(withCounts)
      // Keep a plan the operator chose if it still exists; otherwise the newest with shots.
      setPlanId((cur) =>
        cur && withCounts.some((p) => p.id === cur)
          ? cur
          : (withCounts.find((p) => p.shots > 0) ?? withCounts[0])?.id ?? null
      )
    })()
    return () => {
      live = false
    }
  }, [movie.id, scene?.scene_number])

  useEffect(() => {
    if (!planId || !scene) return setShots([])
    ;(async () => {
      const { data } = await insforge.database
        .from('director_shots')
        .select('id,position,scene_number,shot_type,characters,frame_prompt')
        .eq('plan_id', planId)
        .eq('scene_number', scene.scene_number)
        .order('position', { ascending: true })
      setShots((data ?? []) as Shot[])
    })()
  }, [planId, scene?.scene_number])

  if (loading) return <p>Loading scenes…</p>
  if (scenes.length === 0) {
    return (
      <div>
        <h3>Camera</h3>
        <p className="empty">
          {movie.title} has no scenes yet. Import a screenplay and roll up its scenes first.
        </p>
      </div>
    )
  }

  return (
    <div>
      <h3>Camera</h3>
      <p className="empty">
        Where each shot's camera stands inside the scene's 3D world. Cameras are stored as
        intent — a landmark to look at, a fraction of the room to stand back, a lens — so they
        survive the world being rebuilt, which changes its scale and its origin every time.
      </p>

      <div className="upload-form">
        {plans.length > 0 && (
          <label className="empty">
            Shot list
            <Select
              value={planId ?? ''}
              onValueChange={(v) => setPlanId(v || null)}
              items={plans.map((p) => ({
                value: p.id,
                label: `${new Date(p.created_at).toLocaleString()} · ${p.shots} shot${p.shots === 1 ? '' : 's'} · ${p.status}`
              }))}
            />
          </label>
        )}
        <label className="empty">
          Scene
          <Select
            value={scene ? String(scene.scene_number) : ''}
            onValueChange={(v) => setScene(scenes.find((s) => String(s.scene_number) === v) ?? null)}
            items={scenes.map((s) => ({
              value: String(s.scene_number),
              label: `A${s.act_number}S${s.scene_number} — ${s.location_name ?? 'no location'}`
            }))}
          />
        </label>
      </div>

      {scene && (
        <CameraSurvey
          movie={movie}
          act={scene.act_number}
          scene={scene.scene_number}
          directorPlanId={planId}
          onPlan={setFloorPlan}
        />
      )}

      {scene && shots.length === 0 && (
        <p className="empty">
          No shots in this scene yet — draft a shot list in the Director first, then seed its
          cameras here.
        </p>
      )}

      {shots.length > 0 && (
        <>
          <h4>Coverage — {shots.length} shots</h4>
          <p className="empty">
            Every angle in the scene at once. Change what a camera looks at or how far back it
            stands and re-render its plate; it takes under a second once the splat is loaded.
          </p>
          {/* clip-grid is the app's existing card grid - the same one the
              generations and shot galleries use. */}
          <div className="clip-grid">
            {shots.map((s) => (
              <div className="beat-card" key={s.id}>
                <p>
                  <strong>#{s.position}</strong> <span className="badge">{s.shot_type}</span>{' '}
                  <span className="empty">{(s.characters ?? []).join(', ') || 'no one on screen'}</span>
                </p>
                <p className="empty">{String(s.frame_prompt ?? '').slice(0, 110)}</p>
                <ShotCamera
                  shotId={s.id}
                  position={s.position}
                  plan={floorPlan}
                  directorPlanId={planId}
                  movie={movie}
                  act={scene?.act_number}
                  scene={scene?.scene_number}
                  onPlate={async (imagePath) => {
                    // The plate IS the shot's background: pointing the shot at it
                    // means the next frame redo composites the cast onto the
                    // angle just chosen, with no extra step.
                    await insforge.database
                      .from('director_shots')
                      .update({ plate_path: imagePath })
                      .eq('id', s.id)
                  }}
                />
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  )
}
