/**
 * Applying a palette to something that already exists.
 *
 * This lives on its own because grading is offered from four places now - the
 * Color Palette tab, Image Edit, and the three video tabs - and the two ways a
 * grade is recorded are not obvious. Writing them out per panel is how the
 * Edits list and the clip list would quietly drift apart.
 *
 * The two paths differ in where the pixels are pushed, not in the maths: a
 * still is graded on the browser's canvas with `gradeColor`, a clip goes to
 * ffmpeg with a .cube built from the same function. See `lut.ts`.
 */
import { insforge, comfyViewUrl, type Movie } from './insforge'
import { triggerFlow } from './flowise'
import { gradeImage } from './lut'
import { uploadImageToProject } from './frames'
import type { Palette } from './palettes'

export type GradeResult = { path: string; note: string }

/**
 * Grade a still and file it as an image edit.
 *
 * Recorded in `image_edits` with `engine: 'grade'` deliberately: every image
 * picker in the app already lists the Edits group, so a graded still becomes
 * usable as a reference everywhere without a single new query.
 */
export async function gradeStill(
  movie: Movie,
  palette: Palette,
  srcPath: string,
  srcLabel: string,
  strength: number
): Promise<GradeResult> {
  const png = await gradeImage(comfyViewUrl(srcPath), palette.swatches, strength)
  const up = await uploadImageToProject(movie, png, '_graded', `graded_${Date.now()}.png`)
  if ('error' in up) throw new Error(up.error)
  await insforge.database.from('image_edits').insert([
    {
      movie_id: movie.id,
      prompt: `Graded: ${palette.name}`,
      reference_paths: [srcPath],
      reference_labels: [srcLabel],
      output_path: up.image_path,
      width: 0,
      height: 0,
      steps: 0,
      engine: 'grade',
      palette_id: palette.id,
      status: 'complete'
    }
  ])
  return {
    path: up.image_path,
    note: `Graded with ${palette.name}. It is in the Edits group of every image picker.`
  }
}

/**
 * Grade a rendered clip through the ffmpeg LUT flow.
 *
 * The copy is written with `mode: 'graded'`, which keeps it out of the
 * generation tabs - they filter by their own modes - so nothing can extend
 * from a graded clip and learn the grade as content.
 */
export async function gradeClip(
  movie: Movie,
  palette: Palette,
  clipId: string,
  strength: number
): Promise<GradeResult> {
  const r = await triggerFlow(import.meta.env.VITE_APPLY_LUT_ID, {
    clipId,
    paletteId: palette.id,
    strength
  })
  if (r.state === 'error') throw new Error(r.message)
  const out = JSON.parse(r.message)
  if (out.action !== 'complete') throw new Error(out.reason ?? out.error ?? 'Grading failed.')
  await insforge.database.from('minimax_clips').insert([
    {
      movie_id: movie.id,
      mode: 'graded',
      source_clip_id: clipId,
      prompt: `Graded: ${palette.name}`,
      video_path: out.videoPath,
      status: 'complete'
    }
  ])
  return {
    path: out.videoPath,
    note: `Graded with ${palette.name} in ${(out.bytes / 1e6).toFixed(1)} MB. LUT saved beside it.`
  }
}
