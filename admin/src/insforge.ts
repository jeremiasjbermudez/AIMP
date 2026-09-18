import { createClient } from '@insforge/sdk'

export const insforge = createClient({
  baseUrl: import.meta.env.VITE_INSFORGE_URL,
  anonKey: import.meta.env.VITE_INSFORGE_ANON_KEY
})

export type Movie = {
  id: string
  title: string
  slug: string
  bucket_name: string
  is_active: boolean
  // 'draft' while being written in the builder, 'ready' once exported.
  status: 'draft' | 'ready'
  // 'authored' beats came from the builder; 1-Beat-Generator must not touch them.
  beats_source: 'generated' | 'authored'
  created_at: string
}

export type DocumentRow = {
  id: string
  movie_id: string
  kind: string
  character_id: string | null
  shot_kind: string | null
  original_filename: string
  storage_key: string
  url: string | null
  mime_type: string | null
  size_bytes: number | null
  created_at: string
}

export type Character = {
  id: string
  movie_id: string
  name: string
  gender: string | null
  visual_anchor: string | null
  // Which source the descriptor came from (bible, screenplay, book_rag,
  // reference_image, synthesized). Present in the table and already read by
  // CharactersPanel; it was simply missing from this type.
  visual_anchor_source: string | null
  clothing: string | null
  visual_descriptor: string | null
  lora_path: string | null
  lora_strength_model: number
  lora_strength_clip: number
  // Never seen with an uncovered face (mask, helmet, visor). Face QA inverts
  // for these: a detected face is the defect, not a low similarity score.
  face_covered: boolean
  // The medium reference prompts should assert. Asserting the wrong one
  // overrides the reference image - anime characters rendered as live people.
  render_style: 'photographic' | 'anime' | 'cartoon' | '3d_animated'
  kind: 'person' | 'animal' | 'creature' | 'robot' | 'object'
  created_at: string
}

export type Beat = {
  id: string
  movie_id: string
  sequence_index: number
  act_number: number
  scene_number: number | null
  beat_number: number | null
  beat_code: string | null
  line_start: number
  line_end: number
  scene_heading: string | null
  int_ext: string | null
  location: string | null
  time_of_day: string | null
  summary: string
  raw_text: string
  // Authored action prose, written in the Screenplay Builder. raw_text is
  // rendered from this plus the dialogue; the two are not the same thing.
  action_text: string | null
  // Per-scene hash the Beat Generator uses to decide whether to regenerate.
  source_hash: string | null
  // `presence` decides whether a character needs a visual reference generated
  // for this beat. It is written by the beat generator and present on every
  // row; it was missing from this type, so anything that read characters and
  // wrote them back would silently drop it and turn a voice-only character
  // into an on-screen one.
  characters: { name: string; presence?: 'in_scene' | 'voice_only' | 'off_screen'; blocking?: string }[]
  objects: { name: string; notes?: string }[]
  dialogue: { character: string; parenthetical?: string | null; line: string }[]
}

export type Scene = {
  id: string
  movie_id: string
  act_number: number
  scene_number: number
  int_ext: string | null
  time_of_day: string | null
  // The four prose fields the Panoramic Generator composes its room prompt
  // from, written by 13-Scene-Import.
  location_description: string | null
  atmosphere: string | null
  set_dressing: string | null
  sound_ambience: string | null
  characters_present: string[]
  synopsis: string | null
  location_name: string | null
  scene_heading: string | null
}

// A reference image belonging to the movie rather than to one shot: a prop, a
// colour palette, a location still. Uploaded once, then ticked on whichever
// shots should send it to MiniMax.
export type MovieReferenceImage = {
  id: string
  movie_id: string
  storage_key: string
  original_filename: string
  label: string | null
  created_at: string
}

export type CharacterImage = {
  id: string
  character_id: string
  kind: string
  image_path: string
  version: number
  source: string
  storage_key: string | null
}

export type Shot = {
  id: string
  movie_id: string
  beat_id: string
  act_number: number
  scene_number: number
  reference_character_image_ids: string[]
  // Ad-hoc reference images attached to this shot, as InsForge storage keys.
  // The flow stages them into ComfyUI and appends them after the character refs.
  extra_reference_paths: string[]
  // null on a beat's first shot; on a redo it points at that first shot, so
  // every take of the same setup shares one root id.
  parent_shot_id: string | null
  // Clip length in frames, already snapped to MiniMax's 17k+5 grid by the UI;
  // null on rows created before dialogue-derived timing existed.
  length_frames: number | null
  raw_capture_path: string | null
  cleaned_image_path: string | null
  prompt_text: string | null
  status: 'awaiting_cleanup' | 'cleaned' | 'ready' | 'rendering' | 'complete' | 'failed'
  error_message: string | null
  video_path: string | null
  created_at: string
}

// 'graded' is a colour-graded copy of another clip, not a generation. It is
// never a source for extension - see grade.ts.
export type MinimaxClipMode = 't2v' | 'i2v_first' | 'i2v_first_last' | 'extend' | 'ref' | 'graded'
  // 'v2v' transforms an existing clip: the source carries the performance.
  | 'v2v'
  // 'control' is driven frame by frame by a depth / pose / edge video.
  | 'control'

export type MinimaxClip = {
  id: string
  movie_id: string
  beat_id: string | null
  mode: MinimaxClipMode
  prompt: string
  // InsForge storage keys, not ComfyUI paths - the flow stages them into
  // ComfyUI's input/ folder before LoadImage can read them.
  first_image_path: string | null
  last_image_path: string | null
  // For mode 'extend': the clip this one continues from. The flow reads its
  // rendered video, takes the tail 22 frames plus the matching audio, and
  // anchors them at frame 0 of the new clip.
  source_clip_id: string | null
  /** Extend only: last source frame carried over. NULL = the final frame. */
  guide_end_frame: number | null
  source_shot_id: string | null
  reference_image_paths: string[]
  use_spectrum: boolean
  // The camera axes this clip was rendered with, by preset id, so the form
  // can be restored exactly instead of re-parsed out of the prompt.
  camera: Record<string, string> | null
  // Control to Video only: the storage key of the control video, the
  // ControlNet weight, and what kind of pass the video is (a label).
  control_video_path?: string | null
  control_strength?: number
  control_type?: string | null
  width: number
  height: number
  length: number
  status: 'queued' | 'rendering' | 'complete' | 'failed'
  video_path: string | null
  error_message: string | null
  created_at: string
}

export type QwenCleanup = {
  id: string
  movie_id: string
  act_number: number | null
  scene_number: number | null
  // InsForge storage keys for the uploads; reference_pano_path is a ComfyUI
  // path instead, because a scene panorama already lives on the ComfyUI box.
  source_image_path: string
  reference_image_path: string | null
  reference_pano_path: string | null
  prompt: string
  status: 'queued' | 'rendering' | 'complete' | 'failed'
  cleaned_image_path: string | null
  error_message: string | null
  created_at: string
}

// ComfyUI-local paths ("input/..." / "output/...") aren't InsForge storage URLs -
// they're served by ComfyUI's own /view endpoint, cross-origin from this app.
/**
 * A ComfyUI /view URL for a rendered file.
 *
 * `cacheKey` matters more than it looks. ComfyUI writes a regenerated version
 * into the same folder under the same name, so deleting a character version
 * and regenerating it produces a byte-identical URL for completely different
 * pixels - and the browser serves the old picture from cache. That looked
 * exactly like a prompt bug: helmets that were fixed in the renderer kept
 * showing up in the UI, on files that no longer had them.
 *
 * Pass anything that changes when the file is replaced. A row id is ideal:
 * regenerating deletes the rows and inserts new ones, so the id turns over
 * with the pixels, while a re-render of the same row keeps its cache entry.
 */
export function comfyViewUrl(relPath: string, cacheKey?: string): string {
  const [type, ...rest] = relPath.split('/')
  const filename = rest.pop() ?? ''
  const subfolder = rest.join('/')
  const base = import.meta.env.VITE_COMFY_URL
  const params = new URLSearchParams({ filename, subfolder, type })
  if (cacheKey) params.set('v', cacheKey)
  return `${base}/view?${params.toString()}`
}
