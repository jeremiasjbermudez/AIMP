// 41-Copy-Movie: the same film again, in a different medium.
//
// Back to the Future as anime, then Back to the Future live action. The story,
// the scenes, the cast, the props, the wardrobe, the shot list, the staging, the
// light, the per-shot costume choices - all of that is the FILM, and none of it
// changes because the medium did. Rediscovering it costs days: every beat
// re-broken, every character anchor rewritten, every scene's staging retyped,
// every shimmy re-inserted.
//
// So this copies the WORDS and leaves the PICTURES behind.
//
// Why not copy the pictures too: the render style is chosen here, up front, and
// it is what every prompt is built on top of - the style prefix, the character
// sheets, the panoramas, the prop sheets. An anime sheet is the wrong reference
// for a live-action render, so carrying it over would not save work, it would
// poison it. Every media path comes across as null, deliberately, and the copy
// starts at "generate the references".
//
// Prompts are not copied either, and that is not an oversight. A prompt here is
// DERIVED - the Director rebuilds it from the beats, the characters, the props
// and today's wardrobe every time it is asked to. Copy the words it is built
// from and the prompts come back by themselves, in the new style. The prompt
// library is for a different question: what exactly was sent to make THIS
// picture. That is history, and history belongs to the film that made it.
//
// Input:  {"movieId":"...","title":"Back to the Future (Live Action)",
//          "renderStyle":"photographic","includeShots":true}
// Output: {"action":"copied","movieId":"...","counts":{...}}
const axios = require('axios');
const insforgeUrl = $insforgeUrl;
const insforgeApiKey = $insforgeApiKey;
const comfyUrl = $comfyUrl;
const authHeaders = { Authorization: `Bearer ${insforgeApiKey}` };
const jsonHeaders = { ...authHeaders, 'Content-Type': 'application/json', Prefer: 'return=representation' };

let parsed;
try {
  parsed = JSON.parse(($flow.input || '').toString());
} catch (e) {
  return { error: 'Expected JSON {"movieId":"...","title":"...","renderStyle":"photographic"}' };
}
if (!parsed.movieId) return { error: 'Give the movieId to copy.' };

const STYLES = ['photographic', 'anime', 'cartoon', 'animated'];
const style = STYLES.includes(String(parsed.renderStyle)) ? String(parsed.renderStyle) : 'photographic';

async function records(table, params) {
  const r = await axios.get(`${insforgeUrl}/api/database/records/${table}`, { params, headers: authHeaders });
  return r.data || [];
}
// Every write is checked. A copy that silently loses its props is worse than one
// that fails: the first is discovered days later with half a film built on it.
async function insert(table, rows) {
  if (!rows.length) return [];
  const out = [];
  // In batches, because a long film's beats in one request is a large body and a
  // single rejected row would take the whole thing down with it.
  for (let i = 0; i < rows.length; i += 100) {
    const chunk = rows.slice(i, i + 100);
    const r = await axios.post(`${insforgeUrl}/api/database/records/${table}`, chunk, {
      headers: jsonHeaders,
      validateStatus: () => true
    });
    if (r.status < 200 || r.status >= 300) {
      throw new Error(`${table}: HTTP ${r.status} ${JSON.stringify(r.data).slice(0, 300)}`);
    }
    out.push(...(Array.isArray(r.data) ? r.data : []));
  }
  return out;
}

const src = (await records('movies', { id: `eq.${parsed.movieId}`, select: '*' }))[0];
if (!src) return { error: 'No such movie.' };

const title = String(parsed.title || `${src.title} (copy)`).trim();
// bucket_name is generated from the slug, and a slug that collides would take
// the bucket with it. Unique by construction rather than by hope.
const baseSlug =
  String(parsed.slug || title)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '')
    .slice(0, 40) || 'copy';
let slug = baseSlug;
{
  const taken = new Set((await records('movies', { select: 'slug' })).map((m) => m.slug));
  let n = 2;
  while (taken.has(slug)) slug = `${baseSlug}${n++}`;
}

const counts = {};
let movie;
try {
  // The copy is never the active movie. Almost every flow in this pipeline finds
  // its movie by is_active, so a copy that activated itself would silently
  // redirect work away from whatever is being made right now.
  movie = (
    await insert('movies', [{ title, slug, is_active: false, status: 'draft', beats_source: src.beats_source }])
  )[0];
  if (!movie) throw new Error('the movie row was not returned');

  // The storage bucket, which the movies row only NAMES.
  //
  // bucket_name is a generated column, so inserting the row produces a name and
  // nothing else - the bucket itself is a separate thing that has to be created.
  // Normal movie creation goes through the create-movie function, which does
  // both; this wrote the row directly and left a movie pointing at a bucket that
  // was never there. Nothing failed at copy time: it surfaced later, as
  // "Bucket does not exist" the first time anything tried to upload a script.
  //
  // The parameter is `bucketName`, not `name` - `name` is rejected outright.
  {
    const mk = await axios.post(
      `${insforgeUrl}/api/storage/buckets`,
      { bucketName: movie.bucket_name, public: false },
      { headers: jsonHeaders, validateStatus: () => true }
    );
    // A bucket that already exists is fine - the slug is unique, so this only
    // happens on a retry after a partial copy.
    if (mk.status >= 300 && !/exist/i.test(JSON.stringify(mk.data || ''))) {
      throw new Error(`the storage bucket ${movie.bucket_name} could not be created (HTTP ${mk.status})`);
    }
    counts.bucket = movie.bucket_name;
  }

  // ---------------------------------------------------------------- cast
  // render_style is stamped here rather than left as it was: it is the reason
  // for the copy. The Director reads it off the characters to pick the style
  // prefix every prompt opens with.
  const chars = await records('characters', { movie_id: `eq.${src.id}`, select: '*' });
  const charRows = chars.map((c) => ({
    movie_id: movie.id,
    name: c.name,
    gender: c.gender,
    visual_anchor: c.visual_anchor,
    visual_anchor_source: c.visual_anchor_source,
    clothing: c.clothing,
    visual_descriptor: c.visual_descriptor,
    face_covered: c.face_covered,
    render_style: style
    // No lora_path: a LoRA is trained on the OLD medium's face. Carrying one
    // into a live-action copy would pull every render back towards the anime.
  }));
  // A film with no cast is almost never the one you meant to copy.
  //
  // Copy takes the SELECTED movie, and the selection is at the top of the app
  // rather than on this button - so copying an empty draft while meaning to copy
  // the real film is easy, and the copy looks fine until an import refuses to
  // write into it. Said here, where it is still one click to undo.
  if (!charRows.length) {
    return {
      error:
        `${src.title} has no characters, so the copy would have none either - and nothing can be ` +
        'rendered from it. Copy takes whichever movie is SELECTED at the top of the app, not the one ' +
        'you were last looking at: select the film with the cast you want, then copy that.',
      movieId: movie.id,
      note: `The empty copy "${title}" was created before this was noticed. Delete it.`
    };
  }
  const newChars = await insert('characters', charRows);
  counts.characters = newChars.length;

  // ---------------------------------------------------------------- script
  const beats = await records('beats', { movie_id: `eq.${src.id}`, select: '*', order: 'sequence_index.asc' });
  const beatRows = beats.map((b) => ({
    movie_id: movie.id,
    sequence_index: b.sequence_index,
    act_number: b.act_number,
    scene_number: b.scene_number,
    beat_number: b.beat_number,
    line_start: b.line_start,
    line_end: b.line_end,
    scene_heading: b.scene_heading,
    int_ext: b.int_ext,
    location: b.location,
    time_of_day: b.time_of_day,
    summary: b.summary,
    raw_text: b.raw_text,
    // characters carries each person's `presence` and their `wardrobe` - the
    // costume the screenplay puts them in. Spread whole: rebuilding it by hand
    // would drop presence and turn every voice-only character into an on-screen
    // one.
    characters: b.characters,
    objects: b.objects,
    dialogue: b.dialogue,
    source_hash: b.source_hash,
    action_text: b.action_text
    // beat_code is GENERATED from act/scene/beat. Writing it is an error.
  }));
  const newBeats = await insert('beats', beatRows);
  counts.beats = newBeats.length;
  // Old beat id -> new, for the shot list below. Matched on beat_code, which is
  // generated identically on both sides from the same act/scene/beat numbers.
  const beatByCode = {};
  for (const b of newBeats) beatByCode[b.beat_code] = b.id;
  const newBeatOf = (oldId) => {
    const old = beats.find((x) => x.id === oldId);
    return old && beatByCode[old.beat_code] ? beatByCode[old.beat_code] : null;
  };

  // ---------------------------------------------------------------- scenes
  // Where the light comes from, which way the scene faces, where things stand -
  // typed by hand, per scene, and the single most tedious thing to redo.
  const scenes = await records('scenes', { movie_id: `eq.${src.id}`, select: '*', order: 'scene_number.asc' });
  const sceneRows = scenes.map((s) => ({
    movie_id: movie.id,
    act_number: s.act_number,
    scene_number: s.scene_number,
    scene_heading: s.scene_heading,
    int_ext: s.int_ext,
    location_name: s.location_name,
    location_description: s.location_description,
    time_of_day: s.time_of_day,
    atmosphere: s.atmosphere,
    set_dressing: s.set_dressing,
    sound_ambience: s.sound_ambience,
    characters_present: s.characters_present,
    synopsis: s.synopsis,
    source_hash: s.source_hash,
    key_light: s.key_light,
    screen_direction: s.screen_direction,
    staging: s.staging,
    render_style: style
  }));
  counts.scenes = (await insert('scenes', sceneRows)).length;

  // ------------------------------------------------------- props & wardrobe
  // Descriptions and aliases come across; the SHEETS do not. A sheet is a
  // picture in the old medium, and it is the thing the new render is supposed to
  // replace. The words are what took the work.
  const props = await records('movie_props', { movie_id: `eq.${src.id}`, select: '*' });
  const propRows = props.map((p) => ({
    movie_id: movie.id,
    name: p.name,
    kind: p.kind,
    description: p.description,
    scale_note: p.scale_note,
    notes: p.notes,
    aliases: p.aliases,
    worn_by: p.worn_by,
    render_style: style,
    image_path: null
  }));
  const newProps = await insert('movie_props', propRows);
  counts.props = newProps.length;
  // Old prop id -> new, matched on name, which is what a wardrobe pair means.
  const propByName = {};
  for (const p of newProps) propByName[String(p.name).toLowerCase()] = p.id;
  const newPropOf = (oldId) => {
    const old = props.find((x) => x.id === oldId);
    return old && propByName[String(old.name).toLowerCase()] ? propByName[String(old.name).toLowerCase()] : null;
  };

  // ---------------------------------------------------------------- shots
  // Straight to rendering: the shot list comes across whole, so the copy starts
  // where the original got to rather than re-planning. That keeps the shots
  // inserted by hand, the sizes, the foregrounds and the per-shot wardrobe -
  // decisions about the FILM, which is the same film.
  //
  // A re-plan would throw all of that away and hand the model a fresh guess at
  // coverage. It is the right choice when the story changes. It is the wrong one
  // when only the medium has.
  if (parsed.includeShots !== false) {
    const plans = await records('director_plans', {
      movie_id: `eq.${src.id}`,
      select: '*',
      order: 'created_at.desc'
    });
    // The newest plan only. The older ones are drafts that were superseded, and
    // copying them would carry the film's false starts into a new film.
    const plan = plans[0];
    if (plan) {
      const shots = await records('director_shots', {
        plan_id: `eq.${plan.id}`,
        select: '*',
        order: 'position.asc'
      });
      const newPlan = (
        await insert('director_plans', [
          { movie_id: movie.id, target_seconds: plan.target_seconds, status: 'planned', notes: plan.notes }
        ])
      )[0];
      const shotRows = shots.map((s) => ({
        plan_id: newPlan.id,
        movie_id: movie.id,
        position: s.position,
        scene_number: s.scene_number,
        beat_id: newBeatOf(s.beat_id),
        shot_type: s.shot_type,
        characters: s.characters,
        length_frames: s.length_frames,
        continuity: s.continuity,
        shot_size: s.shot_size,
        foreground: s.foreground,
        source: s.source,
        // The script's own words for this shot. The prompts are rebuilt from
        // these in the new style, which is the whole point - copying the old
        // frame_prompt would copy "Anime screenshot, 2D cel-shaded" into a
        // live-action film.
        raw_frame: s.raw_frame,
        raw_action: s.raw_action,
        // Who is wearing what, per shot, remapped to the new costumes.
        wardrobe: Array.isArray(s.wardrobe)
          ? s.wardrobe.map((w) => ({ on: w.on, prop: newPropOf(w.prop) })).filter((w) => w.prop)
          : null,
        status: 'planned'
        // Everything else is deliberately absent: frame_prompt and motion_prompt
        // are rebuilt, and first_frame_path, last_frame_path, clip_id,
        // plate_path, worn_text, review_state, review_note and review_constraint
        // all describe pictures that do not exist yet. A review verdict copied
        // from the anime would be a judgement about a frame nobody has rendered.
      }));
      counts.shots = (await insert('director_shots', shotRows)).length;
      counts.plan = newPlan.id;
    }
  }

  // The screenplay DOCUMENT is deliberately not copied.
  //
  // A documents row is a pointer into storage - storage_key and url, inside a
  // bucket named after THIS movie's slug. Copying the row would leave the new
  // film reading the old film's files, and deleting the original would break a
  // film that looked complete. The screenplay itself is not lost: every beat
  // carries its own raw_text, action_text and dialogue, and those came across
  // whole. Upload the script to the copy if you want the file there too.
} catch (e) {
  // Said plainly and with what got as far as landing, because a half-copied film
  // looks like a whole one until something is missing from a render.
  return {
    error: 'The copy stopped partway: ' + (e && e.message ? e.message : String(e)),
    movieId: movie && movie.id,
    copiedSoFar: counts,
    note: movie
      ? 'The new movie exists but is incomplete. Delete it and copy again rather than building on it.'
      : 'Nothing was created.'
  };
}

return {
  action: 'copied',
  movieId: movie.id,
  title,
  slug,
  renderStyle: style,
  counts,
  note:
    `Copied as ${style}. The words came across; no pictures did. ` +
    'Generate the character references, the panoramas and the prop sheets, then render frames - the prompts rebuild themselves in the new style from the beats, props and wardrobe.'
};
