// 43-Import-Breakdown: a film's own coverage, into a movie.
//
// _screenplay_from_shots.js turns a breakdown into beats AND a shot per cut. The
// beats were reaching the pipeline; the shots were not. Everything the breakdown
// went to the trouble of finding - how close each shot was, what sat in the
// foreground, how long it held - died at the boundary, and the Director planned
// its own coverage from the beat prose instead. Which is the opposite of why
// anyone breaks a film down.
//
// So this writes both, from the one file:
//
//   beats  - the script: scenes, beats, who is in them, what happens, the lines
//   shots  - a director plan carrying the REAL film's coverage, cut for cut
//
// What it does not do is copy the film. The shots carry sizes, foregrounds and
// durations - craft, which is not anybody's property - and `raw_frame` holds the
// breakdown's own words for what the frame contained. The PROMPTS are rebuilt
// from your characters, your props and your wardrobe in your render style, the
// same way every other shot in this pipeline is. The reference is how it was
// shot, not what was in it.
//
// Input:  {"movieId":"...","screenplayJson":"C:/.../screenplay.json",
//          "what":"both"|"beats"|"shots","act":1}
// Output: {"action":"imported","counts":{...},"unmatched":[...]}
const axios = require('axios');
const fs = require('fs');
const insforgeUrl = $insforgeUrl;
const insforgeApiKey = $insforgeApiKey;
const comfyUrl = $comfyUrl;
const authHeaders = { Authorization: `Bearer ${insforgeApiKey}` };
const jsonHeaders = { ...authHeaders, 'Content-Type': 'application/json', Prefer: 'return=representation' };

let parsed;
try {
  parsed = JSON.parse(($flow.input || '').toString());
} catch (e) {
  return { error: 'Expected JSON {"movieId":"...","screenplayJson":"C:/.../screenplay.json"}' };
}
if (!parsed.movieId) return { error: 'Pick a movie for this to land in.' };
const spPath = String(parsed.screenplayJson || '').trim();
if (!spPath || !fs.existsSync(spPath)) {
  return { error: 'Build a screenplay first - this imports its screenplay.json.' };
}

let script;
try {
  script = JSON.parse(fs.readFileSync(spPath, 'utf8'));
} catch (e) {
  return { error: 'That screenplay.json could not be read: ' + (e && e.message) };
}
const scenes = script.scenes || [];
if (!scenes.length) return { error: 'That screenplay has no scenes in it.' };

const what = ['both', 'beats', 'shots'].includes(String(parsed.what)) ? String(parsed.what) : 'both';
const act = Math.max(1, Math.round(Number(parsed.act) || 1));

async function records(table, params) {
  const r = await axios.get(`${insforgeUrl}/api/database/records/${table}`, { params, headers: authHeaders });
  return r.data || [];
}
// Every write checked. A half-imported script looks like a whole one until a
// render is missing a shot nobody can account for.
async function insert(table, rows) {
  if (!rows.length) return [];
  const out = [];
  for (let i = 0; i < rows.length; i += 100) {
    const r = await axios.post(`${insforgeUrl}/api/database/records/${table}`, rows.slice(i, i + 100), {
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

const movie = (await records('movies', { id: `eq.${parsed.movieId}`, select: 'id,title' }))[0];
if (!movie) return { error: 'No such movie.' };

// REFUSED IF THE MOVIE HAS NO CAST.
//
// Checked before anything is written, because an import into an empty movie
// SUCCEEDS. Thirty-eight shots land, each naming people the movie has never
// heard of, and every one of them will render with no description and no
// reference picture - a stranger in the right position wearing nothing in
// particular. The old version said so in a footnote under a success message,
// which is how a breakdown ended up in a movie with zero characters and looked
// like it had worked.
//
// Some names unmatched is normal and only warned about below - a scene can
// introduce someone new. NONE matched means the wrong movie was picked, and the
// honest answer is to do nothing and say so.
const cast = await records('characters', { movie_id: `eq.${movie.id}`, select: 'name' });
if (!cast.length) {
  return {
    error:
      `${movie.title} has no characters, so every imported shot would name people it has never heard of ` +
      'and render without a description or a reference. Nothing was written.',
    fix:
      'Pick a movie that already has a cast, or copy one that does (Copy movie brings its characters, ' +
      'props and wardrobe across), then import into that.'
  };
}

// MiniMax H3 only renders certain lengths, and 124 frames - about 5.2 seconds -
// is the floor. A shot that held for under that in the original still costs a
// full 124 here; one that ran long is snapped to the nearest step on the grid.
const GRID_MIN = 124;
const GRID_STEP = 17;
const GRID_MAX = 362;
const toFrames = (secs) => {
  const want = Math.round((Number(secs) || 0) * 24);
  if (want <= GRID_MIN) return GRID_MIN;
  const steps = Math.round((Math.min(want, GRID_MAX) - GRID_MIN) / GRID_STEP);
  return Math.min(GRID_MAX, GRID_MIN + steps * GRID_STEP);
};

const counts = {};
const notes = [];
try {
  // ------------------------------------------------------------------ beats
  //
  // Written first, because the shots point at them. Existing beats for this act
  // are cleared rather than added to: importing a breakdown twice should give
  // you the breakdown, not two of it.
  let beatRows = [];
  if (what === 'both' || what === 'beats') {
    const existing = await records('beats', { movie_id: `eq.${movie.id}`, act_number: `eq.${act}`, select: 'id' });
    if (existing.length) {
      // Shots hold a beat_id with ON DELETE NO ACTION, so a beat with a shot on
      // it cannot be deleted - the database refuses. Those shots go first.
      const ids = existing.map((b) => b.id);
      await axios.delete(`${insforgeUrl}/api/database/records/director_shots`, {
        params: { beat_id: `in.(${ids.join(',')})` },
        headers: authHeaders,
        validateStatus: () => true
      });
      const del = await axios.delete(`${insforgeUrl}/api/database/records/beats`, {
        params: { movie_id: `eq.${movie.id}`, act_number: `eq.${act}` },
        headers: authHeaders,
        validateStatus: () => true
      });
      if (del.status >= 300) throw new Error(`the existing act ${act} could not be cleared (HTTP ${del.status})`);
      notes.push(`replaced ${existing.length} beat(s) already in act ${act}`);
    }

    let seq = 10;
    const rows = [];
    // line_start and line_end are NOT NULL with a CHECK that end >= start, and
    // they are meant to point into the screenplay text. There is no uploaded
    // text here, so each beat is given a one-line span at its own position -
    // valid, ordered, and honest about carrying no offsets into a document.
    let line = 1;
    for (const sc of scenes) {
      for (const b of sc.beats || []) {
        rows.push({
          movie_id: movie.id,
          sequence_index: seq,
          act_number: act,
          scene_number: sc.scene,
          beat_number: b.beat,
          line_start: line,
          line_end: line,
          scene_heading: `${sc.int_ext}. ${sc.location} - ${sc.time_of_day}`,
          int_ext: sc.int_ext,
          location: sc.location,
          time_of_day: sc.time_of_day,
          summary: String(b.action_text || '').slice(0, 300),
          action_text: b.action_text || '',
          raw_text: b.action_text || '',
          characters: b.characters || [],
          objects: b.objects || [],
          // The lines heard over this beat's shots. `character` is empty on
          // purpose - the breakdown never knew who spoke, and a name guessed
          // here would be a guess presented as a fact.
          // The parenthetical comes across with the line. It is the slot the
          // beats editor already shows as "(how)", and it is the one part of a
          // performance that survives into a render: the Director writes it into
          // the motion prompt, which is what the video model is given.
          dialogue: (b.dialogue || []).map((d) => ({
            character: d.character || '',
            line: d.line,
            parenthetical: d.parenthetical || ''
          }))
          // beat_code is GENERATED from act/scene/beat. Writing it is an error.
        });
        seq += 10;
        line += 1;
      }
    }
    beatRows = await insert('beats', rows);
    counts.beats = beatRows.length;
    counts.scenes = new Set(scenes.map((s) => s.scene)).size;
  }

  // ------------------------------------------------------------------ shots
  if (what === 'both' || what === 'shots') {
    // The beats to hang shots off: the ones just written, or the ones already
    // there if only shots were asked for.
    const beats = beatRows.length
      ? beatRows
      : await records('beats', { movie_id: `eq.${movie.id}`, act_number: `eq.${act}`, select: 'id,beat_code' });
    const beatByCode = {};
    for (const b of beats) beatByCode[b.beat_code] = b.id;

    // Names the movie does not have. That the movie has SOME cast is settled
    // above - it refuses outright when there is none - so this is the partial
    // case: a scene introducing someone the film has not met, which is normal and
    // only worth saying out loud rather than discovering in a render.
    const known = new Set(cast.map((c) => String(c.name).toUpperCase()));
    const unmatched = new Set();

    const plan = (
      await insert('director_plans', [
        {
          movie_id: movie.id,
          target_seconds: Math.round(scenes.reduce((n, sc) => n + (sc.beats || []).reduce((m, b) => m + (b.shots || []).reduce((k, s) => k + (s.seconds || 0), 0), 0), 0)),
          status: 'planned',
          notes: `Imported from a shot breakdown: ${script.title || ''}`.trim()
        }
      ])
    )[0];

    const rows = [];
    let position = 1;
    for (const sc of scenes) {
      for (const b of sc.beats || []) {
        const people = (b.characters || []).map((c) => String(c.name || '').toUpperCase()).filter(Boolean);
        for (const n of people) if (!known.has(n)) unmatched.add(n);
        for (const s of b.shots || []) {
          rows.push({
            plan_id: plan.id,
            movie_id: movie.id,
            position: position++,
            scene_number: sc.scene,
            beat_id: beatByCode[`A${act}S${sc.scene}B${b.beat}`] || null,
            // The breakdown's own reading of what kind of shot this is.
            shot_type: s.size === 'insert' ? 'insert' : s.size === 'wide' ? 'wide' : 'medium',
            shot_size: s.size || null,
            foreground: s.foreground || null,
            characters: people,
            length_frames: toFrames(s.seconds),
            continuity: 'fresh',
            // The words the prompt is BUILT from, not a prompt. Nothing here
            // writes frame_prompt: the Director rebuilds it from your cast, your
            // props and your wardrobe in your style, which is what makes this a
            // reference to how the film was shot rather than a copy of it.
            raw_frame: s.frame || null,
            // THIS SHOT of movement, not the whole beat of it.
            //
            // raw_action is what the motion prompt is written from, and the motion
            // prompt is what the video model is given. Handed the beat action, every
            // shot in a beat asked for the same thing - and where that action was
            // built from stills it asked for nothing at all, which renders as a
            // photograph that barely moves for five seconds.
            raw_action: s.motion || b.action_text || null,
            source: 'breakdown',
            status: 'planned'
          });
        }
      }
    }
    counts.shots = (await insert('director_shots', rows)).length;
    counts.plan = plan.id;
    if (unmatched.size) {
      notes.push(
        `no character row for ${[...unmatched].join(', ')} - those shots will render without a description or a reference until you add them, or re-run the screenplay with a cast mapping`
      );
    }
  }
} catch (e) {
  return {
    error: 'The import stopped partway: ' + (e && e.message ? e.message : String(e)),
    importedSoFar: counts,
    note: 'Nothing is half-written that cannot be re-imported - running it again replaces the act.'
  };
}

return {
  action: 'imported',
  movie: movie.title,
  counts,
  notes,
  note:
    `${counts.beats || 0} beat(s) and ${counts.shots || 0} shot(s) imported into ${movie.title}. ` +
    (counts.shots
      ? 'Open the Director, pick the new plan, and render - the prompts are written from your own cast and wardrobe when you do.'
      : 'Open the Screenplay tab to see them.')
};
