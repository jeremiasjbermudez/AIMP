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
// @include worker_jobs
// @include llm
// @include blockout_ai

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
  const r = await axios.post(`${insforgeUrl}/api/database/records/${table}`, [row], { headers: { ...headers, Prefer: 'return=representation' } });
  return (r.data || [])[0];
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
if (action === 'stage') {
  const loc = (await rows('set_locations', { id: `eq.${parsed.setLocationId}`, movie_id: `eq.${movieId}`, select: '*' }))[0];
  if (!loc) return { error: 'That set is not part of this project.' };
  const s = parsed.shot || {};
  const shotKey = String(s.shotKey || '').trim();
  if (!/^[A-Za-z0-9_.-]{1,80}$/.test(shotKey)) return { error: 'A shot needs a name of letters, digits, _ . or - (e.g. WH_A_01).' };
  const anchors = (loc.facts && loc.facts.anchors) || {};
  if (s.mark && !anchors[s.mark]) return { error: `${s.mark} is not a mark in ${loc.name}.` };
  if (s.facing && !anchors[s.facing]) return { error: `${s.facing} is not a mark in ${loc.name}.` };

  // H3 lengths are 17k+5 frames; staging renders exactly what the clip will be.
  const frames = Number(s.frames) || 124;
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
    character: s.mark ? {
      id: String(s.character || 'actor').toLowerCase().replace(/[^a-z0-9]+/g, '_'),
      display: s.character || 'Actor', pose: s.pose === 'seated' ? 'seated' : 'standing',
      mark: s.mark, facing: s.facing || s.mark, eye_height_m: Number(s.eyeHeightM) || 1.65
    } : null,
    camera,
    clock: { fps: 24, frames, size: Array.isArray(s.size) ? s.size : [1344, 576] },
    recipe: { name: 'depth_only_v1', control: 'depth', controls: ['depth'] }
  };

  const existing = (await rows('set_shots', { movie_id: `eq.${movieId}`, shot_key: `eq.${shotKey}`, select: 'id' }))[0];
  const row = existing
    ? (await update('set_shots', existing.id, { set_location_id: loc.id, shot, status: 'staging', error_message: null, scene_id: s.sceneId || null }), { id: existing.id })
    : await insert('set_shots', { movie_id: movieId, set_location_id: loc.id, shot_key: shotKey, shot, status: 'staging', scene_id: s.sceneId || null });

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

return { error: `Unknown action '${action}'.` };
