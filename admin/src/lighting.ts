/**
 * Lighting presets: relighting a shot before it moves.
 *
 * This is NOT the palette machinery and cannot reuse it. Colour is a function
 * of pixel value, which is why a grade fits in a 3D LUT. Lighting is spatial -
 * a window shaft, a rim, a practical falling off across a wall depend on where
 * things are and what shape they are - so it has to be generated. The two
 * compose in the order a real production works: light the scene, then grade it.
 *
 * Why the first frame and not the whole clip. Measured on this pipeline before
 * any of it was built: a relit still fed to i2v holds its lighting almost
 * exactly. Across 124 frames the left/right falloff stayed at ~8.7 against 1.03
 * for the flat original, and mean luminance moved less than one unit in 255.
 * Relighting every frame independently would strobe - the eye is far more
 * sensitive to luminance flicker than to colour - so light frame one and let
 * the motion inherit it.
 */
import { insforge, comfyViewUrl, type Movie } from './insforge'
import { triggerFlow } from './flowise'

export type LightingPreset = {
  id: string
  movie_id: string | null
  name: string
  description: string | null
  instruction: string
  thumb_path: string | null
  is_builtin: boolean
  created_at: string
}

/**
 * The scope fence, defined once.
 *
 * "Relight this" on its own invites the model to re-stage the shot. It has to
 * be told what NOT to touch - the same discipline the palette instruction
 * needs. Kept out of the stored preset so it cannot be edited away by accident
 * while tuning the lighting half.
 *
 * The turn clause is not decoration. A preset that read "a hard kicker from
 * behind and to one side" made the model turn the subject around to face away:
 * it attached "from behind" to the PERSON rather than to the light. Saying the
 * subject does not turn costs one clause and closes a failure that silently
 * rewrites the shot.
 */
const SCOPE =
  'Change only the lighting. The camera does not move and the subject does not turn - ' +
  'same pose, same direction faced, same clothing, same framing.'

/** The full prompt for a preset. One sentence of light, then the fence. */
export function lightingInstruction(p: LightingPreset): string {
  return `${p.instruction.trim()} ${SCOPE}`
}

export async function loadLightingPresets(movieId: string): Promise<LightingPreset[]> {
  // Built-ins have no movie_id and belong to every project, so they come back
  // alongside this movie's own.
  const [own, builtin] = await Promise.all([
    insforge.database
      .from('lighting_presets')
      .select('*')
      .eq('movie_id', movieId)
      .order('created_at', { ascending: false }),
    insforge.database
      .from('lighting_presets')
      .select('*')
      .is('movie_id', null)
      .order('name', { ascending: true })
  ])
  return [...((own.data ?? []) as LightingPreset[]), ...((builtin.data ?? []) as LightingPreset[])]
}

export async function saveLightingPreset(
  movie: Movie,
  p: { name: string; instruction: string; description?: string; thumbPath?: string }
) {
  const { error } = await insforge.database.from('lighting_presets').insert([
    {
      movie_id: movie.id,
      name: p.name,
      instruction: p.instruction,
      description: p.description ?? null,
      thumb_path: p.thumbPath ?? null,
      is_builtin: false
    }
  ])
  return error ? { error: error.message } : {}
}

export async function deleteLightingPreset(p: LightingPreset) {
  if (p.is_builtin) return { error: 'Built-in presets cannot be deleted.' }
  const { error } = await insforge.database.from('lighting_presets').delete().eq('id', p.id)
  return error ? { error: error.message } : {}
}

/**
 * The gallery pictures, keyed by preset, for one movie.
 *
 * Per-movie rather than global on purpose: a preview of "Contre-jour" doing its
 * thing to THIS film's characters says far more than the same stock photograph
 * in every project, and it keeps the files inside the movie folder where every
 * other rendered asset lives.
 */
export async function loadPreviews(movieId: string): Promise<Map<string, string>> {
  const { data } = await insforge.database
    .from('lighting_preset_previews')
    .select('preset_id,image_path')
    .eq('movie_id', movieId)
  const out = new Map<string, string>()
  for (const row of (data ?? []) as { preset_id: string; image_path: string }[]) {
    out.set(row.preset_id, row.image_path)
  }
  return out
}

export async function setPreview(movieId: string, presetId: string, imagePath: string) {
  // One preview per preset per movie, so re-rendering replaces rather than
  // piling up. Delete-then-insert because the SDK has no upsert here.
  await insforge.database
    .from('lighting_preset_previews')
    .delete()
    .eq('movie_id', movieId)
    .eq('preset_id', presetId)
  const { error } = await insforge.database
    .from('lighting_preset_previews')
    .insert([{ movie_id: movieId, preset_id: presetId, image_path: imagePath }])
  return error ? { error: error.message } : {}
}

/**
 * Preview image for a preset: this movie's own render, else the library one.
 *
 * A thumb_path starting with "/" is app artwork served from public/, not a
 * ComfyUI output path - the built-in gallery pictures live with the app so
 * they belong to every project and survive any movie being deleted.
 */
export function lightingThumbUrl(p: LightingPreset, previews?: Map<string, string>): string | null {
  const own = previews?.get(p.id)
  if (own) return comfyViewUrl(own, p.id + own)
  if (!p.thumb_path) return null
  return p.thumb_path.startsWith('/') ? p.thumb_path : comfyViewUrl(p.thumb_path, p.id)
}

/**
 * The output size for relighting a given picture.
 *
 * MUST follow the source's aspect ratio. Relighting a 768x1344 full-body shot
 * into a hardcoded 1280x720 does not relight it - it asks the model to
 * recompose a tall standing figure into a wide frame, and what comes back is a
 * re-staged, turned, re-posed person. It reads as "the model spun them round"
 * when really it was told to rebuild the shot.
 *
 * Long edge capped so a relight stays quick, and both edges rounded to a
 * multiple of 16, which is what the latent grid wants.
 */
const MAX_EDGE = 1344

export async function relightSize(sourcePath: string): Promise<{ w: number; h: number }> {
  const img = new Image()
  img.crossOrigin = 'anonymous'
  img.src = comfyViewUrl(sourcePath)
  try {
    await new Promise((res, rej) => {
      img.onload = res
      img.onerror = () => rej(new Error('could not measure'))
    })
  } catch {
    // Unmeasurable: a square is the least destructive guess, because it forces
    // no particular re-framing on either a tall or a wide source.
    return { w: 1024, h: 1024 }
  }
  const w = img.naturalWidth
  const h = img.naturalHeight
  if (!w || !h) return { w: 1024, h: 1024 }
  const scale = Math.min(1, MAX_EDGE / Math.max(w, h))
  const round16 = (v: number) => Math.max(256, Math.round((v * scale) / 16) * 16)
  return { w: round16(w), h: round16(h) }
}

export type RelitImage = { editId: string; outputPath: string }

/**
 * Relight one image and file the result as an edit.
 *
 * Goes through the ordinary Flux Klein edit flow rather than anything new: the
 * reference latent is what holds the identity, and it is already wired. The row
 * lands in `image_edits`, which every image picker lists - so a relit frame is
 * immediately available as an i2v first frame, which is the whole point.
 */
export async function relightImage(
  movie: Movie,
  preset: LightingPreset,
  sourcePath: string,
  sourceLabel: string,
  size?: { w: number; h: number },
  steps = 8
): Promise<RelitImage> {
  // Default to the source's own shape. Passing a size that disagrees with the
  // source is how a relight turns into a recomposition.
  const dims = size ?? (await relightSize(sourcePath))
  const r = await triggerFlow(import.meta.env.VITE_IMAGE_EDIT_ID, {
    movieId: movie.id,
    prompt: lightingInstruction(preset),
    references: [{ path: sourcePath, label: sourceLabel }],
    width: dims.w,
    height: dims.h,
    steps,
    loras: [],
    paletteId: null
  })
  if (r.state === 'error') throw new Error(r.message)
  const out = JSON.parse(r.message)
  if (out.action !== 'complete') throw new Error(out.reason ?? out.error ?? 'Relight failed.')

  // Record which preset lit it, the same way palette_id records a grade, so a
  // look can be traced back to the setup that made it.
  await insforge.database
    .from('image_edits')
    .update({ lighting_preset_id: preset.id })
    .eq('id', out.editId)

  return { editId: out.editId, outputPath: out.outputPath }
}
