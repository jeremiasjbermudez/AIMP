/**
 * Every picture in a movie that can be used as a source, in one list.
 *
 * Character renders, panoramas, edits and saved frames, gathered the same way
 * for every panel that offers "pick something from this movie". It was written
 * inline in the Color Palette tab first; the Relight tab needed exactly the
 * same thing, which is the point at which it stops being a local detail.
 *
 * Everything here is addressed by ComfyUI PATH, not by storage key. That is the
 * constraint that shapes the whole app: the pickers list paths, so anything
 * that only ever reached InsForge storage is invisible to them.
 */
import { insforge, comfyViewUrl } from './insforge'
import { loadMovieFrames, frameLabel, frameGroup } from './frames'
import type { ImageGroup } from './ui/ImageSelect'

export type ImageSource = { id: string; path: string; label: string; group: string }

/**
 * One entry per picture. The same file can be reached by two records - a Qwen
 * clean-up run from the Camera tab is both a "Cleaned plate" and a row in the
 * Qwen Cleanup tab's history - and the pickers should not show it twice. The
 * first listing wins, so group order decides where it appears.
 */
export function dedupeByPath<T extends { path?: string }>(sources: T[]): T[] {
  const seen = new Set<string>()
  return sources.filter((s) => {
    if (!s.path) return true
    const key = s.path.split(String.fromCharCode(92)).join('/')
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

/** The order groups appear in a picker. Characters first: most used. */
export const SOURCE_GROUPS = ['Characters', 'World', 'Camera plates', 'Cleaned plates', 'Face fixes', 'Splat Snapshots', 'Panorama Snapshots', 'Cleanups', 'Edits', 'Frames'] as const

/**
 * Read a table that another module owns.
 *
 * On a partial install the table may not exist, and PostgREST answers that with
 * an error rather than an empty list. That is expected here - it means the
 * module is not installed - so it yields nothing and the other sources still
 * load. Anything else is a real fault and is logged, because a picker that
 * silently loses a source is worse than one that complains.
 */
async function fromModule<T>(
  module: string,
  read: () => PromiseLike<{ data: unknown; error: { message?: string; code?: string } | null }>
): Promise<T[]> {
  try {
    const { data, error } = await read()
    if (error) {
      const message = `${error.code ?? ''} ${error.message ?? ''}`.toLowerCase()
      const missing =
        error.code === '42P01' ||
        message.includes('does not exist') ||
        message.includes('not find the table') ||
        message.includes('schema cache')
      if (!missing) console.warn(`image sources: ${module} could not be read -`, error.message ?? error)
      return []
    }
    return (data ?? []) as T[]
  } catch (e) {
    console.warn(`image sources: ${module} could not be read -`, e)
    return []
  }
}

export async function loadImageSources(movieId: string): Promise<ImageSource[]> {
  const out: ImageSource[] = []

  const chars = await fromModule<any>('characters', () =>
    insforge.database
      .from('characters')
      .select('id,name')
      .eq('movie_id', movieId)
      .order('name', { ascending: true })
  )
  const byId = new Map((chars ?? []).map((c: { id: string; name: string }) => [c.id, c.name]))
  if (chars?.length) {
    const imgs = await fromModule<any>('characters', () =>
      insforge.database
        .from('character_images')
        .select('id,character_id,kind,version,image_path')
        .in(
          'character_id',
          chars.map((c: { id: string }) => c.id)
    )
      )
    for (const im of imgs ?? []) {
      if (!im.image_path) continue
      out.push({
        id: im.id,
        path: im.image_path,
        label: `${byId.get(im.character_id) ?? '?'} — ${im.kind}`,
        group: 'Characters'
      })
    }
  }

  const panos = await fromModule<any>('world', () =>
    insforge.database
      .from('scene_panos')
      .select('act_number,scene_number,image_path')
      .eq('movie_id', movieId)
  )
  for (const p of panos ?? []) {
    if (!p.image_path) continue
    out.push({
      id: `pano-${p.act_number}-${p.scene_number}`,
      path: p.image_path,
      label: `A${p.act_number}S${p.scene_number} panorama`,
      group: 'World'
    })
  }

  // The plate each shot currently stands on - rendered from its camera in the
  // Camera tab and linked to the shot as plate_path. The pickers never saw
  // these: they were written to disk and to the shot, but not to any list a
  // picker reads, so a plate you had just re-rendered could not be chosen.
  // One entry per shot, the CURRENT plate, newest plan first.
  const plated = await fromModule<any>('camera', () =>
    insforge.database
      .from('director_shots')
      .select('id,position,scene_number,shot_type,plate_path,plan_id,created_at')
      .eq('movie_id', movieId)
      .not('plate_path', 'is', null)
      .order('created_at', { ascending: false })
      .order('position', { ascending: true })
  )
  const seen = new Set<string>()
  for (const d of (plated ?? []) as {
    id: string
    position: number
    scene_number: number | null
    shot_type: string
    plate_path: string
    plan_id: string
  }[]) {
    // Several plans can cover the same scene; show each shot once, from the newest plan.
    const key = `${d.scene_number}-${d.position}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({
      id: `plate-${d.id}`,
      path: d.plate_path,
      label: `S${d.scene_number ?? '?'} shot ${d.position} · ${d.shot_type}`,
      group: 'Camera plates'
    })
  }

  // The Qwen Cleanup tab's results (post-splat cleanups). These were in the
  // Image Edit and MiniMax pickers but not here, so the Director could not
  // pick them.
  const cleanups = await fromModule<any>('imaging', () =>
    insforge.database
      .from('qwen_cleanups')
      .select('id,act_number,scene_number,cleaned_image_path,created_at')
      .eq('movie_id', movieId)
      .eq('status', 'complete')
      .order('created_at', { ascending: false })
  )
  for (const c of cleanups ?? []) {
    if (!c.cleaned_image_path) continue
    const where = c.act_number != null && c.scene_number != null ? `A${c.act_number}S${c.scene_number}` : 'no scene'
    out.push({
      id: `cleanup-${c.id}`,
      path: c.cleaned_image_path,
      label: `${where} cleanup · ${new Date(c.created_at).toLocaleString()}`,
      group: 'Cleanups'
    })
  }

  const edits = await fromModule<any>('imaging', () =>
    insforge.database
      .from('image_edits')
      .select('id,prompt,output_path,engine')
      .eq('movie_id', movieId)
      .eq('status', 'complete')
      .order('created_at', { ascending: false })
  )
  for (const e of edits ?? []) {
    if (!e.output_path) continue
    // A face fix is filed as an edit, but it was lost among the prompts under
    // "Edits" - it gets its own group so it can be found and picked.
    const isFaceFix = e.engine === 'face_fix'
    out.push({
      id: `edit-${e.id}`,
      path: e.output_path,
      label: isFaceFix ? String(e.prompt) : String(e.prompt).slice(0, 42),
      group: isFaceFix ? 'Face fixes' : 'Edits'
    })
  }

  for (const f of await loadMovieFrames(movieId)) {
    out.push({ id: `frame-${f.id}`, path: f.image_path, label: frameLabel(f), group: frameGroup(f) })
  }

  return dedupeByPath(out)
}

/** Group them for an ImageSelect, dropping groups that have nothing in them. */
export function toPickerGroups(sources: ImageSource[]): ImageGroup[] {
  const grouped = sources.reduce<Record<string, ImageSource[]>>((acc, s) => {
    ;(acc[s.group] = acc[s.group] ?? []).push(s)
    return acc
  }, {})
  return SOURCE_GROUPS.filter((g) => grouped[g]?.length).map((g) => ({
    label: g,
    items: grouped[g].map((s) => ({ value: s.id, label: s.label, thumb: comfyViewUrl(s.path) }))
  }))
}
