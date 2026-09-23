// Blender sets: a location's versioned Blender block-out, and shots staged in it.
//
// From camera_lab (movie-mvp). A set is built once in Blender and kept by
// revision; each shot places a proxy actor on a mark and a camera around them,
// and staging renders what the video route needs: 16-bit metric depth and an
// actor mask per frame, the camera's matrices, and eight coverage plates of the
// empty room. The renders run on the render host through its worker
// (blender/ in this repository); this flow keeps the project's rows.
//
// Input (JSON):
//   {"action":"locations","movieId":"..."}
//       what the render host has, and which of it this project uses
//   {"action":"add_location","movieId":"...","locationKey":"warming_hut","revision":"v007"}
//   {"action":"stage","movieId":"...","setLocationId":"...","shot":{
//       "shotKey":"WH_A_01", "mark":"ANCHOR_stand_far", "facing":"ANCHOR_stand_near",
//       "pose":"standing", "eyeHeightM":1.68, "character":"Alexander",
//       "lensMm":50, "fStop":2.8, "azimuthDeg":35, "distanceM":2.2, "endDistanceM":2.2,
//       "heightM":1.6, "frames":124, "size":[1344,576], "lighting":"L1"}}
//       or "shot":{"shotKey":"...", "stageCamera":{...a Director's Stage camera...}, ...}
//   {"action":"scout","movieId":"...","shotIds":["...", ...]}
//   {"action":"generate_location","movieId":"...","name":"Lighthouse kitchen",
//       "panoPath":"input/testies/_pano/scene1.png" | "scenePanoId":"...",
//       "notes":"...", "rounds":1}
//       a block-out written by the language model from a panorama, then looked at
//       beside the panorama and fixed `rounds` times; every pass is a revision
//   {"action":"revise_location","movieId":"...","setLocationId":"...","notes":"...","rounds":1}
//       the next revision of any set, a script-built one included
//   {"action":"save_take","movieId":"...","setLocationId":"...","take":{
//       "takeKey":"TK_A1S1_01", "frames":124, "sceneId":"...",
//       "performers":[{"name":"TOMAS", "eyeHeightM":1.68, "keys":[
//           {"t":0, "mark":"ANCHOR_stand_stove", "facing":"ANCHOR_stove"},
//           {"t":3.5, "mark":"ANCHOR_stand_center", "facing":"ANCHOR_calendar"}]}],
//       "cues":[{"t":4.0, "text":"He looks at the calendar"}]}}
//       a performance in the set, built as take.blend to operate a camera against;
//       then "stage" with "takeId" films a pass over it (a camera from the form, or
//       "shot":{"cameraPath":[{"frame":1,"matrix":[[4x4]]}...]} recorded)
//   {"action":"draft_take","movieId":"...","setLocationId":"...",
//       "directorShotIds":["...","..."], "notes":"...", "takeKey":"...", "build":false}
//       the language model blocks the performance for consecutive Director shots
//       (one clip long at most) on this set's marks; returns it for the Takes editor,
//       or builds it straight away with build:true
//   {"action":"make_clip","movieId":"...","setShotId":"...","directorShotId":"...",
//       "characterId":"...", "controlStrength":1.0, "controlEnd":1.0, "render":true}
//       a staged shot as a MiniMax H3 control clip for a Director shot (and so a
//       beat): the depth as the control video, photographic look plates of the
//       set, the character's reference, and a prompt from all of it; with
//       render, 46-MiniMax-Control-To-Video renders it
// @include worker_jobs
// @include comfy_jobs
// @include set_clip
// @include llm
// @include blockout_ai
// @include take_ai

const axios = require('axios');
const insforgeUrl = $insforgeUrl;
const headers = { Authorization: `Bearer ${$insforgeApiKey}`, 'Content-Type': 'application/json' };

let parsed;
try {
  parsed = JSON.parse(($flow.input || '').toString());
} catch (e) {
  return { error: 'Expected JSON {"action":"...","movieId":"..."}' };
}
const action = String(parsed.action || '');
const movieId = parsed.movieId;
if (!movieId) return { error: 'Missing movieId.' };

async function rows(table, params) {
  const r = await axios.get(`${insforgeUrl}/api/database/records/${table}`, { params, headers });
  return r.data || [];
}
async function insert(table, row) {
  const r = await axios.post(`${insforgeUrl}/api/database/records/${table}`, [row], { headers: { ...headers, Prefer: 'return=representation' }, validateStatus: () => true });
  const made = Array.isArray(r.data) ? r.data[0] : null;
  // A refused insert must say why: an empty answer read as a row fails later, far from the cause.
  if (r.status >= 300 || !made) throw new Error(`${table} refused the row (HTTP ${r.status}): ${(r.data && (r.data.message || r.data.details)) || JSON.stringify(r.data).slice(0, 300)}`);
  return made;
}
async function update(table, id, patch) {
  await axios.patch(`${insforgeUrl}/api/database/records/${table}`, patch, { params: { id: `eq.${id}` }, headers });
}

const movie = (await rows('movies', { id: `eq.${movieId}`, select: 'id,slug,title' }))[0];
if (!movie) return { error: 'Project not found.' };

// ---------------------------------------------------------------- locations
if (action === 'locations') {
  const available = await workerCall('get', '/blender/locations');
  const used = await rows('set_locations', { movie_id: `eq.${movieId}`, select: '*', order: 'created_at.asc' });
  return {
    action: 'locations',
    available: available.error ? [] : (available.locations || []).map((l) => ({
      id: l.id, revision: l.revision, name: l.location.name || l.id,
      dimensions: l.location.dimensions_m || null, anchors: Object.keys(l.location.anchors || {}),
      setPieces: Object.keys(l.location.set_pieces || {})
    })),
    availableError: available.error || null,
    used
  };
}

if (action === 'add_location') {
  const key = String(parsed.locationKey || '');
  const rev = String(parsed.revision || '');
  const available = await workerCall('get', '/blender/locations');
  if (available.error) return { error: available.error };
  const hit = (available.locations || []).find((l) => l.id === key && l.revision === rev);
  if (!hit) return { error: `The render host has no set ${key} ${rev}.` };
  const existing = (await rows('set_locations', { movie_id: `eq.${movieId}`, location_key: `eq.${key}`, revision: `eq.${rev}`, select: '*' }))[0];
  if (existing) return { action: 'add_location', setLocation: existing, already: true };
  const row = await insert('set_locations', {
    movie_id: movieId, location_key: key, revision: rev,
    name: hit.location.name || key, blend_path: hit.blend, facts: hit.location
  });
  return { action: 'add_location', setLocation: row };
}

// ---------------------------------------------------------------- stage one shot
// ---------------------------------------------------------------- a take: the performance
const slug = (v) => String(v || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'actor';

/** Build (or rebuild) a take in a set: the save_take action, and draft_take with build. */
async function saveTake(loc, t) {
  const takeKey = String(t.takeKey || '').trim();
  if (!/^[A-Za-z0-9_.-]{1,80}$/.test(takeKey)) return { error: 'A take needs a name of letters, digits, _ . or - (e.g. TK_A1S1_01).' };
  const frames = Number(t.frames) || 124;
  if ((frames - 5) % 17 !== 0) return { error: `${frames} frames is not a MiniMax length (17k+5: 107, 124, 141, 158...).` };
  const anchors = (loc.facts && loc.facts.anchors) || {};
  const performers = [];
  for (const p of t.performers || []) {
    const keys = (p.keys || []).map((k) => ({ t: Number(k.t) || 0, mark: k.mark || undefined, at: k.at || undefined,
      facing: k.facing || undefined, facing_deg: k.facingDeg ?? undefined, pose: k.pose === 'seated' ? 'seated' : 'standing' }));
    if (!keys.length) return { error: `${p.name || 'A performer'} has no moves.` };
    for (const k of keys) {
      if (k.mark && !anchors[k.mark]) return { error: `${k.mark} is not a mark in ${loc.name}.` };
      if (k.facing && !anchors[k.facing]) return { error: `${k.facing} is not a mark in ${loc.name}.` };
      if (k.t > frames / 24) return { error: `A move at ${k.t}s is past the end of a ${(frames / 24).toFixed(1)}s take.` };
    }
    performers.push({ id: slug(p.name), display: p.name || 'Actor', eye_height_m: Number(p.eyeHeightM) || 1.65,
      seat_top_m: Number(p.seatTopM) || 0.6, character_id: p.characterId || null, keys });
  }
  if (!performers.length) return { error: 'A take needs someone in it.' };
  const take = {
    schema: 'take/v0', take_id: takeKey,
    location: { id: loc.location_key, revision: loc.revision, lighting_state: t.lighting || 'L1' },
    clock: { fps: 24, frames, size: Array.isArray(t.size) ? t.size : [1344, 576] },
    performers, cues: (t.cues || []).map((c) => ({ t: Number(c.t) || 0, text: String(c.text || '') })),
    camera: t.camera || undefined
  };
  const existing = (await rows('set_takes', { movie_id: `eq.${movieId}`, take_key: `eq.${takeKey}`, select: 'id' }))[0];
  const row = existing
    ? (await update('set_takes', existing.id, { set_location_id: loc.id, take, status: 'building', error_message: null, scene_id: t.sceneId || null }), { id: existing.id })
    : await insert('set_takes', { movie_id: movieId, set_location_id: loc.id, take_key: takeKey, take, status: 'building', scene_id: t.sceneId || null });
  const built = await workerJob({ kind: 'take', project: movie.slug, take }, { timeoutMs: 20 * 60 * 1000 });
  if (built.status !== 'done') {
    await update('set_takes', row.id, { status: 'failed', error_message: String(built.error).slice(0, 1000) });
    return { action: 'error', reason: 'The take did not build: ' + built.error, takeId: row.id };
  }
  const m = built.result.manifest || {};
  await update('set_takes', row.id, { status: 'built', blend_path: built.result.blend, manifest: m, error_message: null });
  return { action: 'take_built', takeId: row.id, takeKey, blend: built.result.blend, warnings: m.warnings || [],
    performers: Object.keys(m.performers || {}) };
}

if (action === 'save_take') {
  const loc = (await rows('set_locations', { id: `eq.${parsed.setLocationId}`, movie_id: `eq.${movieId}`, select: '*' }))[0];
  if (!loc) return { error: 'That set is not part of this project.' };
  return await saveTake(loc, parsed.take || {});
}

// The Director's motion prompt, without its sound notes: what happens, and who says what when.
const actionOf = (text) => String(text || '')
  .replace(/^Cinematic,\s*live-action\.\s*/i, '')
  .split(/\s*(Overall soundscape:|The only sounds are|Non-diegetic music:)/i)[0]
  .replace(/<\/?d>|\[English\]\s*/g, '').trim();

if (action === 'draft_take') {
  const loc = (await rows('set_locations', { id: `eq.${parsed.setLocationId}`, movie_id: `eq.${movieId}`, select: '*' }))[0];
  if (!loc) return { error: 'That set is not part of this project.' };
  const ids = Array.isArray(parsed.directorShotIds) ? parsed.directorShotIds : [];
  if (!ids.length) return { error: 'Pick the Director shots the take covers.' };
  const shots = (await rows('director_shots', { id: `in.(${ids.join(',')})`, movie_id: `eq.${movieId}`, select: 'id,position,scene_number,shot_type,characters,length_frames,motion_prompt' }))
    .sort((a, b) => a.position - b.position);
  if (shots.length !== ids.length) return { error: 'Some of those Director shots are not in this project.' };
  // One take is one continuous performance, one clip long at most.
  const total = shots.reduce((n, sh) => n + (Number(sh.length_frames) || 124), 0);
  let frames = 124;
  while (frames < total) frames += 17;
  if (frames > 362) return { error: `Those shots run ${(total / 24).toFixed(1)}s, longer than one clip (${(362 / 24).toFixed(1)}s): pick fewer.` };
  let start = 0;
  const shotCtx = shots.map((sh) => {
    const c = { start, seconds: (Number(sh.length_frames) || 124) / 24, type: sh.shot_type, text: actionOf(sh.motion_prompt) };
    start += c.seconds;
    return c;
  });
  const people = [...new Set(shots.flatMap((sh) => (sh.characters || []).map((c) => (typeof c === 'string' ? c : c.name))).filter(Boolean))];
  const prompt = takePrompt({ setName: loc.name, facts: loc.facts || {}, frames, people, shots: shotCtx, notes: parsed.notes });
  try {
    let draft = await askModel(prompt, []);
    let problems = takeProblems(draft, loc.facts || {}, frames);
    if (problems.length) {
      draft = await askModel(prompt + '\n\nYour last answer had these problems: ' + problems.join('; ') + '. Answer again, complete.', []);
      problems = takeProblems(draft, loc.facts || {}, frames);
    }
    if (problems.length) {
      const settings = await llmSettings();
      return { action: 'error', reason: `${settings.model || 'The model'} did not block a usable take: ${problems.join('; ')}.` };
    }
    const scene = shots[0].scene_number;
    const takeKey = String(parsed.takeKey || `TK_S${scene || 0}_${shots.map((sh) => String(sh.position).padStart(2, '0')).join('_')}`).slice(0, 80);
    const take = Object.assign({ takeKey, frames }, takeForSave(draft));
    if (!parsed.build) return { action: 'take_drafted', take, reading: draft.reading || null, shots: shots.map((sh) => sh.position) };
    const built = await saveTake(loc, take);
    return Object.assign({}, built, { take, reading: draft.reading || null });
  } catch (e) {
    return { action: 'error', reason: e.message };
  }
}

if (action === 'stage') {
  const loc = (await rows('set_locations', { id: `eq.${parsed.setLocationId}`, movie_id: `eq.${movieId}`, select: '*' }))[0];
  if (!loc) return { error: 'That set is not part of this project.' };
  const s = parsed.shot || {};
  const shotKey = String(s.shotKey || '').trim();
  if (!/^[A-Za-z0-9_.-]{1,80}$/.test(shotKey)) return { error: 'A shot needs a name of letters, digits, _ . or - (e.g. WH_A_01).' };
  const anchors = (loc.facts && loc.facts.anchors) || {};
  // A shot on a take films its performance; the form's mark and facing are not used.
  const takeRow = parsed.takeId ? (await rows('set_takes', { id: `eq.${parsed.takeId}`, movie_id: `eq.${movieId}`, select: '*' }))[0] : null;
  if (parsed.takeId && !takeRow) return { error: 'That take is not in this project.' };
  if (takeRow && takeRow.status !== 'built') return { error: `Take ${takeRow.take_key} has not been built.` };
  if (takeRow && takeRow.set_location_id !== loc.id) return { error: `Take ${takeRow.take_key} is in another set.` };
  if (!takeRow && s.mark && !anchors[s.mark]) return { error: `${s.mark} is not a mark in ${loc.name}.` };
  if (!takeRow && s.facing && !anchors[s.facing]) return { error: `${s.facing} is not a mark in ${loc.name}.` };

  // H3 lengths are 17k+5 frames; staging renders exactly what the clip will be.
  const frames = takeRow ? takeRow.take.clock.frames : Number(s.frames) || 124;
  if ((frames - 5) % 17 !== 0) return { error: `${frames} frames is not a MiniMax length (17k+5: 107, 124, 141, 158...).` };
  const move = { enabled: !!s.move, start_frame: Number(s.moveStart) || 25, end_frame: Number(s.moveEnd) || frames - 38, easing: 'smoothstep' };
  const camera = s.stageCamera
    ? { id: 'A', lens_mm: s.stageCamera.lens_mm, sensor_width_mm: s.stageCamera.sensor_width_mm || 36, f_stop: s.stageCamera.f_stop || 2.8,
        aim: 'eyes', move: s.stageCamera.move || move, stage_camera: s.stageCamera }
    : { id: 'A', lens_mm: Number(s.lensMm) || 50, sensor_width_mm: 36, f_stop: Number(s.fStop) || 2.8, aim: 'eyes',
        azimuth_deg_from_character: Number(s.azimuthDeg) || 0,
        start_distance_m: Number(s.distanceM) || 2.0,
        end_distance_m: s.move ? (Number(s.endDistanceM) || Number(s.distanceM) || 2.0) : (Number(s.distanceM) || 2.0),
        height_m: Number(s.heightM) || 1.6, move };
  // The shot camera_lab's stage reads (shot/v0), with this project's values.
  const shot = {
    schema: 'shot/v0',
    shot_id: shotKey,
    scene: s.sceneLabel || loc.name,
    location: { id: loc.location_key, revision: loc.revision, lighting_state: s.lighting || 'L1' },
    character: takeRow ? (() => {
      const perf = takeRow.take.performers.find((p) => p.id === s.performer) || takeRow.take.performers[0];
      return { id: perf.id, display: perf.display, pose: 'standing', eye_height_m: perf.eye_height_m, performer: perf.id };
    })() : s.mark ? {
      id: String(s.character || 'actor').toLowerCase().replace(/[^a-z0-9]+/g, '_'),
      display: s.character || 'Actor', pose: s.pose === 'seated' ? 'seated' : 'standing',
      mark: s.mark, facing: s.facing || s.mark, eye_height_m: Number(s.eyeHeightM) || 1.65
    } : null,
    // A recorded camera replaces the computed one frame for frame.
    camera: Array.isArray(s.cameraPath) && s.cameraPath.length ? Object.assign({}, camera, { path: s.cameraPath }) : camera,
    take: takeRow ? (() => {
      const perf = (takeRow.manifest.performers || {})[s.performer] ? s.performer : Object.keys(takeRow.manifest.performers || {})[0];
      const pm = takeRow.manifest.performers[perf];
      return { id: takeRow.take_key, project: movie.slug, performer: perf, root: pm.root, eyes: pm.eyes,
        manifest: `takes/${movie.slug}/${takeRow.take_key}/take_manifest.json` };
    })() : undefined,
    clock: { fps: 24, frames, size: Array.isArray(s.size) ? s.size : [1344, 576] },
    recipe: { name: 'depth_only_v1', control: 'depth', controls: ['depth'] }
  };

  const existing = (await rows('set_shots', { movie_id: `eq.${movieId}`, shot_key: `eq.${shotKey}`, select: 'id' }))[0];
  const row = existing
    ? (await update('set_shots', existing.id, { set_location_id: loc.id, shot, status: 'staging', error_message: null, scene_id: s.sceneId || (takeRow && takeRow.scene_id) || null, take_id: takeRow ? takeRow.id : null }), { id: existing.id })
    : await insert('set_shots', { movie_id: movieId, set_location_id: loc.id, shot_key: shotKey, shot, status: 'staging', scene_id: s.sceneId || (takeRow && takeRow.scene_id) || null, take_id: takeRow ? takeRow.id : null });

  const staged = await workerJob({ kind: 'stage', project: movie.slug, shot }, { timeoutMs: 40 * 60 * 1000 });
  if (staged.status !== 'done') {
    await update('set_shots', row.id, { status: 'failed', job_id: staged.id || null, error_message: String(staged.error).slice(0, 1000) });
    return { action: 'error', reason: 'Staging failed: ' + staged.error, shotId: row.id };
  }
  // What the camera sees, occlusion included: set pieces always, sometimes or
  // never in frame, and a warning when the background is too plain to hold.
  const vis = await workerJob({ kind: 'visibility', shotDir: staged.result.shotDir }, { timeoutMs: 15 * 60 * 1000 });
  await update('set_shots', row.id, {
    status: 'staged', job_id: staged.id, stage: staged.result,
    visibility: vis.status === 'done' ? vis.result : null,
    error_message: vis.status === 'done' ? null : 'Staged; the visibility pass failed: ' + vis.error
  });
  return { action: 'staged', shotId: row.id, shotKey, stage: staged.result, visibility: vis.result || null };
}

// ---------------------------------------------------------------- tech scout
if (action === 'scout') {
  const ids = Array.isArray(parsed.shotIds) ? parsed.shotIds : [];
  if (!ids.length) return { error: 'Pick the shots to scout.' };
  const shots = await rows('set_shots', { id: `in.(${ids.join(',')})`, movie_id: `eq.${movieId}`, select: 'id,shot_key,status' });
  const ready = shots.filter((r) => r.status === 'staged');
  if (!ready.length) return { error: 'None of those shots has been staged yet.' };
  const name = (movie.slug + '_' + Date.now()).replace(/[^A-Za-z0-9_.-]/g, '_');
  const job = await workerJob({ kind: 'scout', name, shotDirs: ready.map((r) => `shots/${movie.slug}/${r.shot_key}`) }, { timeoutMs: 30 * 60 * 1000 });
  if (job.status !== 'done') return { action: 'error', reason: 'Tech scout failed: ' + job.error };
  for (const r of ready) await update('set_shots', r.id, { scout_sheet: job.result.sheet });
  return { action: 'scouted', sheet: job.result.sheet, coverage: job.result.coverage, shots: ready.map((r) => r.shot_key) };
}

// ---------------------------------------------------------------- block-outs by a model
// The process camera_lab's locations were made by: a model writes the room,
// Blender builds it, the model looks at what was built beside the reference and
// fixes it, and every pass is kept as a revision.

/** A picture under the sets root, as base64 for the model. */
async function setsImage(rel) {
  // Built by hand: the flow sandbox has no URLSearchParams.
  const parts = ('sets/' + rel).split('/');
  const q = 'type=input&subfolder=' + encodeURIComponent(parts.slice(0, -1).join('/')) + '&filename=' + encodeURIComponent(parts[parts.length - 1]);
  const r = await axios.get(String($comfyUrl).replace(/\/$/, '') + '/view?' + q, { responseType: 'arraybuffer', timeout: 60000 });
  return Buffer.from(r.data).toString('base64');
}

async function askModel(prompt, images) {
  const res = await llmChat({
    stream: false, think: false, format: 'json',
    options: { temperature: 0.2, num_ctx: 32768 },
    messages: [{ role: 'user', content: prompt, images }]
  }, { timeout: 20 * 60 * 1000 });
  return blockoutJson(res.data.message.content);
}

async function revisionsOf(key) {
  const listing = await workerCall('get', '/blender/locations');
  return (listing.locations || []).filter((l) => l.id === key).map((l) => l.revision);
}

/** Build one revision on the render host and record it. */
async function buildRevision(key, location, meta) {
  const rev = blockoutNextRevision(await revisionsOf(key));
  const job = await workerJob({ kind: 'build', locationKey: key, revision: rev, location }, { timeoutMs: 20 * 60 * 1000 });
  if (job.status !== 'done') throw new Error(`Building ${key} ${rev} failed: ${job.error}`);
  const settings = await llmSettings();
  return insert('set_locations', {
    movie_id: movieId, location_key: key, revision: rev, name: location.name || key,
    blend_path: job.result.blend, facts: job.result.location, previews: job.result.report.previews,
    build_report: { objects: job.result.report.objects, warnings: job.result.report.warnings, errors: job.result.report.errors },
    source: meta.source || null, parent_id: meta.parentId || null, change_note: location.change || meta.changeNote || null,
    made_by: (settings.provider || '') + ':' + (settings.model || '')
  });
}

/** What the next revision has to fix: the director's notes, the build, and the staged shots. */
async function feedbackFor(row, notes) {
  const out = [];
  if (notes) out.push('Director: ' + notes);
  const rep = row.build_report || {};
  for (const e of rep.errors || []) out.push('Build error: ' + e);
  for (const w of rep.warnings || []) out.push('Build warning: ' + w);
  const shots = await rows('set_shots', { set_location_id: `eq.${row.id}`, status: 'eq.staged', select: 'shot_key,visibility' });
  for (const s of shots) {
    const v = s.visibility || {};
    if (v.background_risk) out.push(`Shot ${s.shot_key}: ${v.background_risk}`);
    for (const t of v.bare_thirds || []) out.push(`Shot ${s.shot_key}: the ${typeof t === 'string' ? t : JSON.stringify(t)} of frame is bare wall`);
  }
  return out;
}

/** One look-and-fix pass on a recorded revision; returns the new row. */
async function reviseOnce(row, notes) {
  let loc = row.facts || {};
  if (!loc.blockout) {
    // Built by a script before this process: describe it as data first.
    const ex = await workerJob({ kind: 'export', locationKey: row.location_key, revision: row.revision }, { timeoutMs: 10 * 60 * 1000 });
    if (ex.status !== 'done') throw new Error('Could not read the existing set as data: ' + ex.error);
    loc = Object.assign({}, loc, { blockout: ex.result.blockout });
  }
  loc = Object.assign({}, loc, { revision: row.revision, name: row.name });
  // Previews: this revision's own, or rendered now for one built before previews existed.
  let previews = row.previews;
  if (!previews || !previews.length) {
    const key = row.location_key + '_' + row.revision;
    const pv = await workerJob({ kind: 'build', preview: true, locationKey: key, revision: 'r' + Date.now(), location: loc }, { timeoutMs: 20 * 60 * 1000 });
    if (pv.status !== 'done') throw new Error('Could not render the set to look at: ' + pv.error);
    previews = pv.result.report.previews;
  }
  const reference = ((row.source || {}).views || []);
  const images = [];
  for (const rel of reference) images.push(await setsImage(rel));
  for (const t of ['N', 'E', 'S', 'W']) images.push(await setsImage(previews.find((p) => p.endsWith(`view_${t}.png`))));
  images.push(await setsImage(previews.find((p) => p.endsWith('plan.png'))));
  const change = await askModel(blockoutRevisePrompt(loc, await feedbackFor(row, notes), reference.length === 4), images);
  const next = blockoutNormalise(blockoutApply(loc, change));
  const problems = blockoutProblems(next);
  if (problems.length) throw new Error(`The revision of ${row.name} ${row.revision} could not be built: ${problems.join('; ')}`);
  return buildRevision(row.location_key, next, { source: row.source, parentId: row.id, changeNote: change.change_note });
}

if (action === 'generate_location') {
  const name = String(parsed.name || '').trim();
  if (!name) return { error: 'Name the location.' };
  const key = (String(parsed.locationKey || name).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'location').slice(0, 60);
  if ((await revisionsOf(key)).length) return { error: `There is already a location called ${key}; revise it instead, or pick another name.` };
  let panoPath = parsed.panoPath;
  let scenePanoId = null;
  if (parsed.scenePanoId) {
    const p = (await rows('scene_panos', { id: `eq.${parsed.scenePanoId}`, movie_id: `eq.${movieId}`, select: 'id,image_path' }))[0];
    if (!p) return { error: 'That panorama is not in this project.' };
    panoPath = p.image_path;
    scenePanoId = p.id;
  }
  if (!panoPath) return { error: 'Give a panorama to build from.' };
  const views = await workerJob({ kind: 'pano_views', pano: panoPath, name: key }, { timeoutMs: 10 * 60 * 1000 });
  if (views.status !== 'done') return { action: 'error', reason: 'Could not cut the panorama into views: ' + views.error };
  const source = { panoPath, scenePanoId, views: views.result.views };
  try {
    const images = [];
    for (const rel of source.views) images.push(await setsImage(rel));
    const prompt = blockoutFirstPrompt(name, parsed.notes);
    let first = await askModel(prompt, images);
    let problems = blockoutProblems(blockoutNormalise(first.location || first));
    if (problems.length) {
      // One more try, told what was wrong: cheaper than a build that cannot work.
      first = await askModel(prompt + '\n\nYour last answer could not be built: ' + problems.join('; ') + '. Answer again, complete.', images);
      problems = blockoutProblems(blockoutNormalise(first.location || first));
    }
    if (problems.length) {
      const settings = await llmSettings();
      return { action: 'error', reason: `${settings.model || 'The model'} did not write a usable block-out (${problems.join('; ')}). A stronger vision model does this far better.` };
    }
    const loc = blockoutNormalise(Object.assign({}, first.location || first, {
      name, reference_source: panoPath, reference_plates: source.views, status: 'block-out by a model; not surveyed'
    }));
    let row = await buildRevision(key, loc, { source, changeNote: 'First block-out, from the panorama.' });
    const made = [row];
    const rounds = Math.max(0, Math.min(3, parsed.rounds === undefined ? 1 : Number(parsed.rounds) || 0));
    for (let i = 0; i < rounds; i++) {
      row = await reviseOnce(row, parsed.notes);
      made.push(row);
    }
    return { action: 'generated', setLocation: row, revisions: made.map((r) => ({ id: r.id, revision: r.revision, change: r.change_note })), survey: first.survey || null };
  } catch (e) {
    return { action: 'error', reason: e.message };
  }
}

if (action === 'revise_location') {
  const row = (await rows('set_locations', { id: `eq.${parsed.setLocationId}`, movie_id: `eq.${movieId}`, select: '*' }))[0];
  if (!row) return { error: 'That set is not part of this project.' };
  try {
    let cur = row;
    const made = [];
    const rounds = Math.max(1, Math.min(3, Number(parsed.rounds) || 1));
    for (let i = 0; i < rounds; i++) {
      cur = await reviseOnce(cur, parsed.notes);
      made.push(cur);
    }
    return { action: 'revised', setLocation: cur, revisions: made.map((r) => ({ id: r.id, revision: r.revision, change: r.change_note })) };
  } catch (e) {
    return { action: 'error', reason: e.message };
  }
}

// ---------------------------------------------------------------- a staged shot as a clip
const LOOK_SEED = 1703;      // camera_lab's plate seed and denoise
const LOOK_DENOISE = 0.55;

/** One photographic look plate: Z-Image over a Blender coverage plate, as camera_lab made them. */
async function lookPlate(initRel, prompt, prefix) {
  const g = {
    '1': { class_type: 'UNETLoader', inputs: { unet_name: 'z_image_turbo_bf16.safetensors', weight_dtype: 'default' } },
    '3': { class_type: 'ModelSamplingAuraFlow', inputs: { model: ['1', 0], shift: 3 } },
    '4': { class_type: 'CLIPLoader', inputs: { clip_name: 'qwen_3_4b.safetensors', type: 'lumina2', device: 'default' } },
    '5': { class_type: 'CLIPTextEncode', inputs: { clip: ['4', 0], text: prompt } },
    '6': { class_type: 'ConditioningZeroOut', inputs: { conditioning: ['5', 0] } },
    '7': { class_type: 'VAELoader', inputs: { vae_name: 'ae.safetensors' } },
    '8': { class_type: 'LoadImage', inputs: { image: initRel } },
    '9': { class_type: 'VAEEncode', inputs: { pixels: ['8', 0], vae: ['7', 0] } },
    '10': { class_type: 'KSampler', inputs: { model: ['3', 0], positive: ['5', 0], negative: ['6', 0], latent_image: ['9', 0],
      seed: LOOK_SEED, steps: 8, cfg: 1, sampler_name: 'res_multistep', scheduler: 'simple', denoise: LOOK_DENOISE } },
    '11': { class_type: 'VAEDecode', inputs: { samples: ['10', 0], vae: ['7', 0] } },
    '12': { class_type: 'SaveImage', inputs: { images: ['11', 0], filename_prefix: prefix } }
  };
  const sub = await comfySubmit($comfyUrl, g);
  if (sub.error) throw new Error('Look plate: ' + sub.error);
  const done = await comfyWait($comfyUrl, sub.promptId, { timeoutMs: 15 * 60 * 1000 });
  if (done.status !== 'success') throw new Error('Look plate: ' + (done.error || done.status));
  const img = ((done.record.outputs || {})['12'] || {}).images || [];
  if (!img.length) throw new Error('Look plate: nothing saved');
  return 'output/' + (img[0].subfolder ? img[0].subfolder + '/' : '') + img[0].filename;
}

// Any failure comes back as a reason, not a flow crash (which reaches the app as a bare HTTP 500).
let clipStep = 'starting';
async function makeClip() {
  clipStep = 'reading the shot';
  const shotRow = (await rows('set_shots', { id: `eq.${parsed.setShotId}`, movie_id: `eq.${movieId}`, select: '*' }))[0];
  if (!shotRow) return { error: 'That shot is not in this project.' };
  if (shotRow.status !== 'staged' || !shotRow.stage) return { error: `${shotRow.shot_key} has not been staged yet.` };
  const loc = (await rows('set_locations', { id: `eq.${shotRow.set_location_id}`, select: '*' }))[0];
  if (!loc) return { error: 'The set this shot was staged in is gone.' };
  const facts = loc.facts || {};

  clipStep = 'reading the Director shot and beat';
  // The Director's shot and its beat, when the shot is for one.
  let dshot = null;
  let beat = null;
  const dId = parsed.directorShotId || shotRow.director_shot_id;
  if (dId) {
    dshot = (await rows('director_shots', { id: `eq.${dId}`, movie_id: `eq.${movieId}`, select: '*' }).catch(() => []))[0] || null;
    if (!dshot) return { error: 'That Director shot is not in this project (is the director module installed?).' };
    if (dshot.beat_id) beat = (await rows('beats', { id: `eq.${dshot.beat_id}`, select: 'id,summary,raw_text' }).catch(() => []))[0] || null;
  }

  clipStep = 'finding the character and their reference';
  // Who is in it: the character asked for, else the Director shot's first, else the staged proxy's name.
  const chars = await rows('characters', { movie_id: `eq.${movieId}`, select: 'id,name,visual_anchor' }).catch(() => []);
  const wanted = parsed.characterId
    || ((dshot && (dshot.characters || [])[0]) ? String((dshot.characters[0].name || dshot.characters[0])) : '')
    || ((shotRow.shot || {}).character || {}).display || '';
  const character = chars.find((c) => c.id === wanted) || chars.find((c) => String(c.name).toLowerCase() === String(wanted).toLowerCase()) || null;
  let identity = null;
  if (character) {
    const imgs = await rows('character_images', { character_id: `eq.${character.id}`, select: 'kind,image_path,storage_key,created_at', order: 'created_at.desc' }).catch(() => []);
    const pref = ['front', 'portrait', 'qa_front', 'sheet'];
    const pick = pref.map((k) => imgs.find((i) => i.kind === k && (i.image_path || i.storage_key))).find(Boolean) || imgs.find((i) => i.image_path || i.storage_key);
    identity = pick ? (pick.image_path || pick.storage_key) : null;
  }

  clipStep = 'making the control video';
  // 1. The control video, and the facts about the camera the prompt needs.
  const ctl = await workerJob({ kind: 'control', shotDir: shotRow.stage.shotDir, plateCount: 2 }, { timeoutMs: 20 * 60 * 1000 });
  if (ctl.status !== 'done') return { action: 'error', reason: 'Could not make the control video: ' + ctl.error };
  const m = ctl.result;

  clipStep = 'making the look plates';
  // 2. Look plates for the coverage plates this camera faces: made once per set revision.
  const look = Object.assign({}, loc.look || {});
  const lookPrompt = setClipLookPrompt(facts.room_prompt || loc.name);
  const plates = [];
  try {
    for (const cam of m.plates || []) {
      if (!look[cam]) {
        look[cam] = await lookPlate(`sets/${shotRow.stage.blenderDir}/plates/${cam}.png`, lookPrompt,
          `${movie.slug}/_sets/look/${loc.location_key}_${loc.revision}_${cam}`);
        await update('set_locations', loc.id, { look });
      }
      plates.push(look[cam]);
    }
  } catch (e) {
    return { action: 'error', reason: e.message };
  }

  clipStep = 'writing the prompt';
  // 3. The prompt. A shot on a take gets the take's action with its times.
  const sh = shotRow.shot || {};
  const takeRow = shotRow.take_id ? (await rows('set_takes', { id: `eq.${shotRow.take_id}`, select: 'take' }))[0] : null;
  // The Director's motion prompt is the action. Its frame prompt describes a
  // first-frame still (lens, framing, a different moment) and would contradict
  // the staged camera, so it stays out.
  const action = (dshot && dshot.motion_prompt) || (beat ? beat.summary : '');
  const prompt = setClipPrompt({
    locationName: loc.name || loc.location_key, roomPrompt: facts.room_prompt, lensMm: m.lens_mm || (sh.camera || {}).lens_mm,
    frames: m.frames, fps: m.fps, person: character ? { name: character.name, look: character.visual_anchor } : null,
    pictures: plates.length, view: m.view, trajectory: m.trajectory,
    action: action || (beat ? beat.summary : ''), visibility: shotRow.visibility,
    timeline: takeRow ? setClipTimeline(takeRow.take) : null,
    cameraMotion: m.camera_motion, recorded: !!((sh.camera || {}).path)
  });

  clipStep = 'recording the clip';
  // 4. The clip, recorded against the Director's shot and beat so it lands where they look for it.
  const size = m.size || [1344, 576];
  const clip = await insert('minimax_clips', {
    // Not source_shot_id: that points at the screenplay breakdown's shots table.
    // A Director shot finds its clip through director_shots.clip_id, set below.
    movie_id: movieId, beat_id: (dshot && dshot.beat_id) || shotRow.beat_id || null,
    mode: 'control', prompt, width: size[0], height: size[1], length: m.frames, status: 'queued',
    reference_image_paths: [identity, ...plates].filter(Boolean),
    control_video_path: 'input/sets/' + m.video, control_type: 'depth',
    // Full strength for the whole schedule. camera_lab's 0.7, released at 0.5-0.6,
    // was for a different control node and came with frame anchors; on this one
    // H3 ignored the depth at those settings and framed its own wide shot
    // (Testies LK_S2_TOMAS_MCU, 23 September), and followed it at 1.0 / 1.0.
    control_strength: Number(parsed.controlStrength) || 1.0,
    control_end: Number(parsed.controlEnd) || 1.0,
    camera: { source: 'blender_set', set_shot_id: shotRow.id, location: loc.location_key, revision: loc.revision }
  });
  await update('set_shots', shotRow.id, {
    director_shot_id: dshot ? dshot.id : shotRow.director_shot_id, beat_id: (dshot && dshot.beat_id) || shotRow.beat_id,
    control: m, clip_id: clip.id
  });

  const summary = { clipId: clip.id, controlVideo: 'input/sets/' + m.video, references: clip.reference_image_paths,
    identity: !!identity, character: character ? character.name : null, directorShot: dshot ? dshot.id : null,
    beat: beat ? beat.summary : null, prompt };
  if (!parsed.render) {
    if (dshot) await axios.patch(`${insforgeUrl}/api/database/records/director_shots`, { clip_id: clip.id }, { params: { id: `eq.${dshot.id}` }, headers });
    return Object.assign({ action: 'clip_ready' }, summary);
  }

  clipStep = 'rendering';
  // 5. Render through Control to Video, the same flow the Video tab uses.
  let out;
  try {
    const r = await axios.post(`${String($flowiseUrl).replace(/\/$/, '')}/api/v1/prediction/{{flow:46-MiniMax-Control-To-Video}}`,
      { question: JSON.stringify({ clipId: clip.id }) },
      { timeout: 3 * 60 * 60 * 1000, validateStatus: () => true, headers: { Authorization: `Bearer ${$flowiseApiKey}` } });
    out = JSON.parse((r.data && r.data.text) || '{}');
  } catch (e) {
    return Object.assign({ action: 'error', reason: 'Control to Video could not be reached: ' + e.message }, summary);
  }
  if (dshot) await axios.patch(`${insforgeUrl}/api/database/records/director_shots`, { clip_id: clip.id }, { params: { id: `eq.${dshot.id}` }, headers });
  // Control to Video stops watching after about 17 minutes and says 'pending';
  // the render carries on and the clip row is completed when it lands.
  const state = out.action === 'complete' ? 'rendered' : out.action === 'pending' ? 'rendering' : 'error';
  return Object.assign({ action: state, reason: out.reason || out.error, videoPath: out.videoPath, promptId: out.promptId }, summary);
}

if (action === 'make_clip') {
  try {
    return await makeClip();
  } catch (e) {
    return { action: 'error', reason: `While ${clipStep}: ` + (e && e.message ? e.message : String(e)) };
  }
}

return { error: `Unknown action '${action}'.` };
