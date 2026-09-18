/**
 * Camera vocabulary: movement, framing, angle, lens and optical look.
 *
 * Five independent axes rather than one list, because they compose - a slow
 * push-in can be a low-angle 24mm wide with anamorphic flare, and a single flat
 * dropdown cannot say that.
 *
 * Which axes apply to which tab is declared in videoKinds.ts, alongside every
 * other per-kind fact, rather than as a second rule living here.
 */
import { insforge } from './insforge'

export type CameraCategory = 'movement' | 'framing' | 'angle' | 'lens' | 'look'

export type CameraPreset = {
  id: string
  movie_id: string | null
  category: CameraCategory
  name: string
  instruction: string
  description: string | null
  sort_order: number
  is_builtin: boolean
}

/** Display order and labels for the axes. */
export const CAMERA_AXES: { key: CameraCategory; label: string; hint: string }[] = [
  { key: 'movement', label: 'Move', hint: 'What the camera does' },
  { key: 'framing', label: 'Shot', hint: 'How tight the frame is' },
  { key: 'angle', label: 'Angle', hint: 'Where the camera sits' },
  { key: 'lens', label: 'Lens', hint: 'Focal length and character' },
  { key: 'look', label: 'Look', hint: 'Focus, flare, grain, speed' }
]


export async function loadCameraPresets(movieId: string): Promise<CameraPreset[]> {
  const [own, builtin] = await Promise.all([
    insforge.database.from('camera_presets').select('*').eq('movie_id', movieId),
    insforge.database.from('camera_presets').select('*').is('movie_id', null)
  ])
  return [...((own.data ?? []) as CameraPreset[]), ...((builtin.data ?? []) as CameraPreset[])].sort(
    (a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name)
  )
}

/**
 * One sentence from whatever axes are chosen, in shooting order.
 *
 * Shot, then angle, then lens, then movement, then look - the order a
 * cinematographer would call it, which also reads as one instruction rather
 * than a pile of tags. Empty when nothing is picked, so nothing is appended.
 */
export function cameraInstruction(
  presets: CameraPreset[],
  picked: Partial<Record<CameraCategory, string>>
): string {
  const order: CameraCategory[] = ['framing', 'angle', 'lens', 'movement', 'look']
  const parts = order
    .map((cat) => presets.find((p) => p.id === picked[cat])?.instruction)
    .filter((x): x is string => !!x)
  if (parts.length === 0) return ''
  return 'Camera: ' + parts.join('; ') + '.'
}

/**
 * Take the composed camera sentence back off a stored prompt.
 *
 * The line is appended at render time so the model reads it, which means a
 * stored prompt already contains it. Loading that straight back into the form
 * and generating again would append a SECOND one. The format is ours and fixed
 * ("Camera: ..." as the final paragraph), so removing it is exact rather than
 * a guess - and a prompt the operator wrote themselves that merely mentions a
 * camera is untouched, because only a trailing paragraph starting with the
 * marker is stripped.
 */
export function stripCameraLine(prompt: string): string {
  return prompt.replace(/\n{1,2}Camera:[^\n]*$/, '').trimEnd()
}
