import { insforge, type Beat, type Movie } from '../insforge'
import { triggerFlow, parseFlowJson, triggerOrchestrator, type RunStatus } from '../flowise'
import { buildTree, flatten, renumber, type DraftBeat, type ScreenplayTree, type SceneNode } from './model'
import { renderScreenplay } from './render'
import { normaliseIntExt } from './model'

// Loading is a plain select. Saving is NOT: reordering swaps sequence_index and
// beat_number between rows that already exist, which transiently violates two
// unique constraints. That has to happen inside one transaction with the
// constraints deferred, which a REST call cannot do - so the whole renumbered
// beat list goes through one Postgres function instead.

export async function loadTree(movieId: string): Promise<{ tree: ScreenplayTree } | { error: string }> {
  const { data, error } = await insforge.database
    .from('beats')
    .select('*')
    .eq('movie_id', movieId)
    .order('sequence_index', { ascending: true })
  if (error) return { error: error.message }
  return { tree: buildTree((data ?? []) as Beat[]) }
}

const SAVED_FIELDS = [
  'id', 'sequence_index', 'act_number', 'scene_number', 'beat_number',
  'scene_heading', 'int_ext', 'location', 'time_of_day', 'summary',
  'action_text', 'raw_text', 'line_start', 'line_end', 'source_hash',
  'characters', 'objects', 'dialogue'
] as const

export async function saveTree(
  movieId: string,
  tree: ScreenplayTree
): Promise<{ tree: ScreenplayTree } | { error: string }> {
  const beats = flatten(tree)
  if (beats.length === 0) return { error: 'Nothing to save.' }

  const payload = beats.map((b) => {
    const row: Record<string, unknown> = {}
    for (const k of SAVED_FIELDS) row[k] = (b as unknown as Record<string, unknown>)[k]
    // raw_text is what 13-Scene-Import reads to write its location prose, so it
    // tracks the authored text. But a beat imported from a screenplay has real
    // raw_text and no action_text yet - blanking that would destroy the only
    // copy of its script excerpt. Send null instead, which the RPC coalesces to
    // the existing value, and only overwrite when there is something to write.
    const rendered = renderBeatText(b.action_text, b.dialogue)
    row.raw_text = rendered.trim() ? rendered : null
    return row
  })

  const { data, error } = await insforge.database.rpc('screenplay_apply_structure', {
    p_movie_id: movieId,
    p_beats: payload
  })
  if (error) return { error: error.message }
  return { tree: buildTree((data ?? []) as Beat[]) }
}

/** The beat's screenplay text: action, then each dialogue block. */
export function renderBeatText(
  action: string | null,
  dialogue: { character: string; parenthetical?: string | null; line: string }[]
): string {
  const parts: string[] = []
  if (action && action.trim()) parts.push(action.trim())
  for (const d of dialogue) {
    if (!d.character.trim() && !d.line.trim()) continue
    const cue = d.character.trim().toUpperCase()
    const paren = d.parenthetical?.trim() ? `(${d.parenthetical.trim()})\n` : ''
    parts.push(`${cue}\n${paren}${d.line.trim()}`)
  }
  return parts.join('\n\n')
}

// ------------------------------------------------------------------ assist

const ASSIST = () => import.meta.env.VITE_SCREENPLAY_ASSIST_ID

type ProposalScene = {
  int_ext?: string
  location?: string
  time_of_day?: string
  beats?: Partial<DraftBeat>[]
}

function toDraft(b: Partial<DraftBeat>): DraftBeat {
  return {
    id: null,
    act_number: 1,
    scene_number: 1,
    beat_number: 1,
    beat_code: null,
    sequence_index: 0,
    scene_heading: null,
    int_ext: null,
    location: null,
    time_of_day: null,
    summary: b.summary ?? '',
    action_text: b.action_text ?? '',
    raw_text: '',
    line_start: 0,
    line_end: 0,
    source_hash: null,
    characters: b.characters ?? [],
    objects: b.objects ?? [],
    dialogue: b.dialogue ?? []
  }
}

/** Turn what the writer typed into acts/scenes/beats. Returns a tree to review. */
export async function breakDown(text: string): Promise<{ tree: ScreenplayTree } | { error: string }> {
  const res = parseFlowJson<{ proposal: { acts: { scenes?: ProposalScene[] }[] } }>(
    await triggerFlow(ASSIST(), { mode: 'breakdown', text })
  )
  if (!res.ok) return { error: res.message }

  const acts = (res.data.proposal.acts ?? []).map((a) => ({
    scenes: (a.scenes ?? []).map(
      (s): SceneNode => ({
        scene_heading: null,
        int_ext: normaliseIntExt(s.int_ext),
        location: s.location ?? '',
        time_of_day: s.time_of_day ?? 'DAY',
        beats: (s.beats ?? []).map(toDraft)
      })
    )
  }))
  if (acts.length === 0) return { error: 'The model returned no acts.' }
  return { tree: renumber({ acts }) }
}

/** Fill in / sharpen one beat. Never drops existing dialogue. */
export async function enhanceBeat(
  beat: DraftBeat,
  sceneHeading: string,
  instruction: string
): Promise<{ fields: Partial<DraftBeat>; dialogueKept: boolean } | { error: string }> {
  const res = parseFlowJson<{ beat: Partial<DraftBeat>; dialogueKept: boolean }>(
    await triggerFlow(ASSIST(), {
      mode: 'enhance',
      sceneHeading,
      instruction,
      beat: {
        summary: beat.summary,
        action_text: beat.action_text,
        characters: beat.characters,
        objects: beat.objects,
        dialogue: beat.dialogue
      }
    })
  )
  if (!res.ok) return { error: res.message }
  return { fields: res.data.beat, dialogueKept: res.data.dialogueKept }
}

export type BibleProposal = {
  characters: { name: string; gender?: string; visual_anchor: string; inferred?: boolean }[]
  locations: {
    act_number: number
    scene_number: number
    location_description: string
    atmosphere: string
    set_dressing: string
    sound_ambience: string
  }[]
  // Props and wardrobe. A prop has no reference sheet unless one is made, so
  // every render invents it again - which is why scale_note carries as much
  // weight as the description, and why the aliases matter: one draft called the
  // same object "a wish star crystal", "the crystal" and "wish star".
  props: {
    name: string
    kind: 'prop' | 'wardrobe'
    description: string
    scale_note: string
    aliases: string[]
  }[]
}

/** Propose a character bible and location prose from the saved beats. */
export async function proposeBible(movieId: string): Promise<BibleProposal | { error: string }> {
  const res = parseFlowJson<BibleProposal>(await triggerFlow(ASSIST(), { mode: 'bible', movieId }))
  if (!res.ok) return { error: res.message }
  return res.data
}

/**
 * Write the approved bible. Characters go straight in; location prose lands on
 * the scenes rows, which is exactly what the Panoramic Generator reads.
 * Scene rows must exist first, so 13-Scene-Import runs before this.
 */
export async function commitBible(movie: Movie, bible: BibleProposal): Promise<{ ok: true } | { error: string }> {
  for (const c of bible.characters) {
    const name = c.name.toUpperCase()
    const { data: existing } = await insforge.database
      .from('characters')
      .select('id')
      .eq('movie_id', movie.id)
      .eq('name', name)
    const row = { gender: c.gender ?? null, visual_anchor: c.visual_anchor, visual_anchor_source: 'bible' }
    if (existing && existing.length > 0) {
      const { error } = await insforge.database.from('characters').update(row).eq('id', existing[0].id)
      if (error) return { error: `${name}: ${error.message}` }
    } else {
      const { error } = await insforge.database
        .from('characters')
        .insert([{ movie_id: movie.id, name, ...row, lora_strength_model: 1, lora_strength_clip: 0.31 }])
      if (error) return { error: `${name}: ${error.message}` }
    }
  }

  for (const l of bible.locations) {
    const { error } = await insforge.database
      .from('scenes')
      .update({
        location_description: l.location_description,
        atmosphere: l.atmosphere,
        set_dressing: l.set_dressing,
        sound_ambience: l.sound_ambience
      })
      .eq('movie_id', movie.id)
      .eq('act_number', l.act_number)
      .eq('scene_number', l.scene_number)
    if (error) return { error: `A${l.act_number}S${l.scene_number}: ${error.message}` }
  }

  // Props are matched on name so committing twice updates rather than
  // duplicates - the same way characters are handled above. image_path is never
  // touched here: a sheet that has already been rendered is real work, and a
  // re-proposal must not wipe it.
  // Matched on the aliases as well as the name, in both directions. The model
  // names an object however the script most fully says it - a movie that
  // already had "the wish star" got a proposal for "the wish star crystal",
  // which on an exact-name match would have inserted a second row for the same
  // object, and two rows means two descriptions competing in one prompt.
  const { data: already } = await insforge.database
    .from('movie_props')
    .select('id,name,aliases')
    .eq('movie_id', movie.id)
  const norm = (v: string) => v.trim().toLowerCase().replace(/^the\s+/, '')
  const known = (already ?? []) as { id: string; name: string; aliases: string[] | null }[]
  const claimed = new Set<string>()

  // A new prop is drawn in whatever the cast are drawn in. Without this it took
  // the column default, photographic - which is how the first wish star came
  // back looking like a photograph in an anime film. Only applied to props
  // being created: an existing one keeps whatever look was chosen for it.
  const { data: castRows } = await insforge.database
    .from('characters')
    .select('render_style')
    .eq('movie_id', movie.id)
  const castStyles = (castRows ?? []).map((c: { render_style?: string }) => c.render_style)
  const filmStyle =
    (['anime', 'cartoon', 'animated'] as const).find((k) => castStyles.includes(k)) ?? 'photographic'

  for (const p of bible.props ?? []) {
    const name = p.name.trim()
    if (!name) continue
    const row = {
      kind: p.kind === 'wardrobe' ? 'wardrobe' : 'prop',
      description: p.description?.trim() || null,
      scale_note: p.scale_note?.trim() || null,
      aliases: Array.isArray(p.aliases) ? p.aliases.map((a) => String(a).trim()).filter(Boolean) : []
    }
    const mine = new Set([name, ...row.aliases].map(norm))
    // Score the candidates rather than taking the first hit, and let each
    // existing row be claimed once. A shared generic alias otherwise collides:
    // asked to describe one state at a time the model returns "wish star
    // crystal" AND "cracked wish star crystal", both carrying the alias
    // "crystal", and both would land on the same row - the second silently
    // overwriting the first. A name match beats an alias match; the loser
    // becomes its own row, which is what a second state should be.
    const score = (k: { name: string; aliases: string[] | null }) => {
      if (norm(k.name) === norm(name)) return 2
      return [k.name, ...(k.aliases ?? [])].map(norm).some((t) => mine.has(t)) ? 1 : 0
    }
    let match: (typeof known)[number] | undefined
    let best = 0
    for (const k of known) {
      if (claimed.has(k.id)) continue
      const s = score(k)
      if (s > best) {
        best = s
        match = k
      }
    }
    if (match) claimed.add(match.id)
    const existing = match ? [match] : []
    if (existing.length > 0) {
      // The name you chose is kept - it is what you read the list by - but the
      // model's fuller name is folded in as an alias, since that is the wording
      // the script actually uses and the one a shot has to match on.
      const merged = [...row.aliases, name, ...(existing[0].aliases ?? [])]
        .map((a) => a.trim())
        .filter(Boolean)
        .filter((a) => norm(a) !== norm(existing[0].name))
      const { error } = await insforge.database
        .from('movie_props')
        .update({ ...row, aliases: [...new Set(merged)] })
        .eq('id', existing[0].id)
      if (error) return { error: `${name}: ${error.message}` }
    } else {
      const { error } = await insforge.database
        .from('movie_props')
        .insert([{ movie_id: movie.id, name, ...row, render_style: filmStyle }])
      if (error) return { error: `${name}: ${error.message}` }
    }
  }
  return { ok: true }
}

/** Roll the saved beats up into scenes rows (13-Scene-Import). */
export function runSceneImport(prose: boolean): Promise<RunStatus> {
  return triggerFlow(import.meta.env.VITE_SCENE_IMPORT_ID, prose ? '' : '--no-prose')
}

/** Hand the finished screenplay to the pipeline. */
export function startOrchestration(scope: string): Promise<RunStatus> {
  return triggerOrchestrator(scope)
}

// ------------------------------------------------------------------ export

/**
 * Render the screenplay, store it as the movie's screenplay document, and write
 * each beat's real line range plus its scene's source hash. The hash is the one
 * 1-Beat-Generator would compute, so a stray run sees the scenes as unchanged.
 */
export async function exportScreenplay(
  movie: Movie,
  tree: ScreenplayTree
): Promise<{ text: string; bytes: number } | { error: string }> {
  const { text, beatSpans, sceneHash } = renderScreenplay(tree, movie.title)

  for (const b of flatten(tree)) {
    const span = beatSpans.get(b)
    if (span) {
      b.line_start = span.start
      b.line_end = span.end
    }
    b.source_hash = sceneHash.get(b) ?? null
  }
  const saved = await saveTree(movie.id, tree)
  if ('error' in saved) return { error: saved.error }

  const file = new File([new Blob([text], { type: 'text/plain' })], `${movie.slug}.txt`, {
    type: 'text/plain'
  })
  const key = `screenplay/${movie.id}/${movie.slug}.txt`
  const { data: up, error: upErr } = await insforge.storage.from(movie.bucket_name).upload(key, file)
  if (upErr || !up) return { error: upErr?.message ?? 'Upload failed' }

  // The Beat Generator errors on more than one screenplay document, so the old
  // row is removed rather than left alongside.
  const { data: old } = await insforge.database
    .from('documents')
    .select('id')
    .eq('movie_id', movie.id)
    .eq('kind', 'screenplay')
  for (const d of old ?? []) await insforge.database.from('documents').delete().eq('id', d.id)

  const { error: insErr } = await insforge.database.from('documents').insert([
    {
      movie_id: movie.id,
      kind: 'screenplay',
      original_filename: `${movie.slug}.txt`,
      storage_key: up.key,
      url: (up as { url?: string }).url ?? null,
      mime_type: 'text/plain',
      size_bytes: text.length
    }
  ])
  if (insErr) return { error: insErr.message }

  await insforge.database.from('movies').update({ status: 'ready' }).eq('id', movie.id)
  return { text, bytes: text.length }
}
