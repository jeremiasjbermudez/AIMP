import { insforge, type Movie } from './insforge'

/**
 * Saving a frame grabbed out of a rendered clip.
 *
 * The frame is uploaded into ComfyUI's output folder, under the movie's own
 * directory, rather than InsForge storage. That choice is the whole point:
 * every image picker in the app except Ref to Video builds its list from
 * ComfyUI *paths*, so a storage-key row could not appear in them. With a real
 * path a grabbed frame is exactly as usable as a character shot or a rendered
 * edit - Image Edit, Image to Video, Ref to Video and the panorama guide can
 * all load it.
 *
 * ComfyUI serves /upload/image with permissive CORS, so the browser posts the
 * PNG directly; no flow, no queue, no GPU.
 */
const COMFY = import.meta.env.VITE_COMFY_URL

export type SavedFrame = { image_path: string; name: string }

/**
 * Put an image into the movie's own ComfyUI folder and return its path.
 *
 * Shared by anything that needs a picture to be addressable the way generated
 * images are. InsForge storage would work for the bytes, but a storage KEY
 * cannot appear in the image pickers - every one of them builds its list from
 * ComfyUI paths - and it cannot be shown with a plain <img src> either.
 */
export async function uploadImageToProject(
  movie: Movie,
  blob: Blob,
  subdir: string,
  name: string
): Promise<{ image_path: string } | { error: string }> {
  const form = new FormData()
  form.append('image', new File([blob], name, { type: blob.type || 'image/png' }))
  // One project, one folder - alongside _pano, _minimax_ref and the rest.
  form.append('subfolder', `${movie.slug}/${subdir}`)
  form.append('type', 'output')
  form.append('overwrite', 'true')
  try {
    const res = await fetch(`${COMFY}/upload/image`, { method: 'POST', body: form })
    if (!res.ok) return { error: `ComfyUI rejected the image (HTTP ${res.status}).` }
    const up: { name: string; subfolder: string } = await res.json()
    return { image_path: `output/${up.subfolder ? up.subfolder + '/' : ''}${up.name}` }
  } catch (e) {
    return { error: `Could not reach ComfyUI: ${e instanceof Error ? e.message : String(e)}` }
  }
}

export async function saveFrameToProject(
  movie: Movie,
  png: Blob,
  opts: { clipId?: string; frame: number; label?: string }
): Promise<SavedFrame | { error: string }> {
  const name = `frame_${opts.frame}_${Date.now()}.png`
  const up = await uploadImageToProject(movie, png, '_frames', name)
  if ('error' in up) return up
  const image_path = up.image_path

  const { error } = await insforge.database.from('movie_frames').insert([
    {
      movie_id: movie.id,
      source_clip_id: opts.clipId ?? null,
      source_label: opts.label ?? null,
      frame_number: opts.frame,
      image_path
    }
  ])
  if (error) return { error: error.message }
  return { image_path, name }
}

/**
 * Viewer snapshots - a splat or panorama angle captured by hand.
 *
 * Stored as movie_frames rows, because that is the one table every image picker
 * already reads; a file with no row is invisible to all of them. The folder is
 * what tells them apart: anything under _SplatSnapshots is grouped as
 * "Splat Snapshots" rather than Frames (see frameGroup).
 */
export const SPLAT_SNAPSHOT_DIR = '_SplatSnapshots'
export const PANO_SNAPSHOT_DIR = '_PanoSnapshots'

export async function saveSnapshotToProject(
  movie: Movie,
  png: Blob,
  opts: { kind: 'splat' | 'pano'; label: string }
): Promise<SavedFrame | { error: string }> {
  const name = `${opts.kind}_${Date.now()}.png`
  const up = await uploadImageToProject(movie, png, opts.kind === 'splat' ? SPLAT_SNAPSHOT_DIR : PANO_SNAPSHOT_DIR, name)
  if ('error' in up) return up
  const { error } = await insforge.database.from('movie_frames').insert([
    { movie_id: movie.id, source_label: opts.label, frame_number: null, image_path: up.image_path }
  ])
  if (error) return { error: error.message }
  return { image_path: up.image_path, name }
}

/**
 * A picture uploaded from disk, made a real movie picture: file in the project
 * folder AND a movie_frames row. Without the row it exists on disk but no picker
 * can list it - which is exactly how an upload used to vanish after "Choose File".
 */
export async function saveUploadToProject(
  movie: Movie,
  file: File,
  label: string
): Promise<SavedFrame | { error: string }> {
  const name = `upload_${Date.now()}_${file.name.replace(/[^\w.-]+/g, '_')}`
  const up = await uploadImageToProject(movie, file, '_uploads', name)
  if ('error' in up) return up
  const { error } = await insforge.database.from('movie_frames').insert([
    { movie_id: movie.id, source_label: label, frame_number: null, image_path: up.image_path }
  ])
  if (error) return { error: error.message }
  return { image_path: up.image_path, name }
}

/** Which picker group a saved frame belongs in. */
/** Label prefix a Camera-tab Clean up stamps on the movie_frames row it records. */
export const CLEANED_PLATE_LABEL = 'Cleaned plate'

export function frameGroup(f: { image_path: string; source_label?: string | null }): 'Cleaned plates' | 'Splat Snapshots' | 'Panorama Snapshots' | 'Frames' {
  // A cleaned plate is recognised by its label, not its path: Qwen and Flux
  // write to different folders and the Flux folder is shared with ordinary edits.
  if (f.source_label?.startsWith(CLEANED_PLATE_LABEL)) return 'Cleaned plates'
  const p = f.image_path.split(String.fromCharCode(92)).join('/')
  if (p.includes(`/${SPLAT_SNAPSHOT_DIR}/`)) return 'Splat Snapshots'
  if (p.includes(`/${PANO_SNAPSHOT_DIR}/`)) return 'Panorama Snapshots'
  return 'Frames'
}

export type MovieFrame = {
  id: string
  source_label: string | null
  frame_number: number | null
  image_path: string
  created_at: string
}

/** Every saved frame for a movie, newest first - for the image pickers. */
export async function loadMovieFrames(movieId: string): Promise<MovieFrame[]> {
  const { data } = await insforge.database
    .from('movie_frames')
    .select('id,source_label,frame_number,image_path,created_at')
    .eq('movie_id', movieId)
    .order('created_at', { ascending: false })
  return (data ?? []) as MovieFrame[]
}

/** "A1S1B1 · frame 120" - enough to tell two frames apart in a list. */
export function frameLabel(f: MovieFrame): string {
  // Snapshots have no frame number; their label already says what they are.
  if (f.frame_number == null) return `${f.source_label ?? 'snapshot'} · ${new Date(f.created_at).toLocaleString()}`
  const where = f.source_label ? `${f.source_label} · ` : ''
  return `${where}frame ${f.frame_number ?? '?'}`
}
