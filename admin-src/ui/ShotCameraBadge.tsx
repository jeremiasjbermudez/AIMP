import { useEffect, useState } from 'react'
import { insforge } from '../insforge'

/**
 * What a shot's camera is, in one line, while you are shooting.
 *
 * Read-only on purpose. Placing cameras happens in the Camera tab, where the
 * whole scene's angles can be seen together - coverage cannot be judged one
 * table row at a time. Here the only questions are "does this shot have a
 * camera" and "is its plate still current", and both are answered by the line
 * itself rather than by fetching a picture into an already-heavy panel.
 */
export function ShotCameraBadge({ shotId }: { shotId: string }) {
  const [text, setText] = useState<string | null>(null)
  const [warn, setWarn] = useState<string | null>(null)

  useEffect(() => {
    let live = true
    ;(async () => {
      const { data: cams } = await insforge.database
        .from('shot_cameras')
        .select('id,look_at_landmark,distance_frac,fov_deg,is_manual,explicit_world')
        .eq('shot_id', shotId)
        .eq('is_chosen', true)
        .limit(1)
      const cam = ((cams ?? []) as {
        id: string
        look_at_landmark: string
        distance_frac: number
        fov_deg: number
        is_manual: boolean
        explicit_world: string | null
      }[])[0]
      if (!live) return
      if (!cam) return setText(null)

      setText(
        `${cam.look_at_landmark} · ${cam.distance_frac.toFixed(2)}× · ${Math.round(cam.fov_deg)}°` +
          (cam.is_manual ? ' · tuned' : '')
      )

      // Stale means the plate was rendered against an earlier build of this
      // room, so its background no longer matches the other shots. Worth saying
      // here because it is invisible in the picture itself.
      const { data: plates } = await insforge.database
        .from('camera_plates')
        .select('floor_plan_id,created_at')
        .eq('shot_camera_id', cam.id)
        .order('created_at', { ascending: false })
        .limit(1)
      const plate = ((plates ?? []) as { floor_plan_id: string }[])[0]
      if (!plate || !live) return
      const { data: plans } = await insforge.database
        .from('scene_floor_plans')
        .select('id')
        .eq('id', plate.floor_plan_id)
        .limit(1)
      if (live && ((plans ?? []) as unknown[]).length === 0) setWarn('plate stale')
    })()
    return () => {
      live = false
    }
  }, [shotId])

  if (!text) return <p className="empty">Camera — none</p>
  return (
    <p className="empty">
      Camera — {text}
      {warn ? <span className="error"> · {warn}</span> : null}
    </p>
  )
}
