// Block-outs written by a model: what it is told, and how its answer is applied.
//
// Included with `// @include blockout_ai`. camera_lab's locations were each built
// by a Python script a model wrote. Here the model writes data instead, which
// blender/build_blockout.py turns into the .blend, so nothing it writes is run.
// The process is camera_lab's: write the room, build it, look at it beside the
// reference, fix what is wrong, and keep every revision.

const BLOCKOUT_RULES = [
  'You are a set builder making a Blender block-out of a room: simple solid shapes at the right size and place,',
  'so a film camera can be staged inside it. Depth, actor masks and what the camera sees all come from it; the',
  'photographic look comes later from elsewhere, so shapes and positions matter far more than detail.',
  '',
  'Coordinates: metres, Z up, the room centred on the origin at floor level. North is +Y, east is +X, south -Y,',
  'west -X. The four reference views are 90 degrees wide and level, all from the one spot the panorama was taken:',
  'view N looks north (+Y), E looks east (+X), S south, W west. The left edge of view N is 45 degrees toward west,',
  'its right edge 45 degrees toward east. Something in the middle of view E is east of the camera.',
  'That spot is often not the middle of the room: judge it from how near each wall and object looks, and give it',
  'as blockout.view_from [x, y, z] (z about 1.5). The block-out is rendered from there to compare with the views.',
  '',
  'Scale from what has a known size: a door is about 2.0 m high and 0.85 m wide, a table top 0.74 m high, a',
  'chair seat 0.45 m, a kitchen counter 0.9 m, a window sill about 0.9 m, a person 1.7 m.',
  '',
  'Shapes (every object: name, shape, at [x,y,z] = its centre, material, optional rot_deg [x,y,z]):',
  '  box       size [x,y,z]',
  '  cylinder  radius, height            (upright; rot_deg [90,0,0] lays it along Y)',
  '  cone      radius1 (bottom), radius2 (top), height',
  '  torus     major, minor              (flat; rot_deg [90,0,0] stands it up facing Y)',
  '  sphere    radius',
  '  poly      verts [[x,y,z]...], faces [[i,j,k,...]...]  (only for what nothing else fits)',
  '  repeat    {count, step [dx,dy,dz]}  on any object, for rows (studs, shelves, pipes)',
  '  exterior  true for anything deliberately outside the room (snow, a street through a door)',
  '',
  'The room shell: blockout.room = {shape "rect" or "round", wall, floor, ceiling (material names),',
  'openings [...]}. A rect room is dimensions_m.width (x) by depth (y); a round room has diameter width.',
  'eave_height is the wall height; ridge_height above it gives a pitched (rect) or conical (round) roof.',
  'Rect openings: {name, wall "north"|"south"|"east"|"west", center (x along north/south walls, y along',
  'east/west), bottom, width, height, fill (material, e.g. glass; omit for an open doorway), frame (material)}.',
  'Round openings use azimuth_deg (0 north, 90 east, 180 south, 270 west) instead of wall and center.',
  'Do not model walls, floor or roof as objects: the shell builds them.',
  '',
  'Build what the views show: every piece of furniture, anything on the walls (shelves, pictures, pipes,',
  'calendars, hooks), and the practical lights. A camera needs edges and landmarks behind the actor, so a',
  'bare wall is a fault: put on it what the reference shows. Name the parts of one thing with one prefix',
  '("Stove body", "Stove pipe", "Stove door") and list that prefix in set_pieces under the phrase a',
  'director would use ("wood stove"). Keep it under about 90 objects. Keep things off each other and inside',
  'the walls unless they really touch.',
  '',
  'Anchors (marks): ANCHOR_stand_<where> for at least two places an actor can stand on open floor, at z 0,',
  'half a metre from furniture; ANCHOR_sit_<where> at a chair seat height if there are chairs; and one',
  'anchor at each thing someone might face (ANCHOR_window, ANCHOR_door, ANCHOR_stove...), at its centre.',
  '',
  'Lights: one per practical source you can see (lamp, stove fire, window daylight), as blockout.lights',
  '[{name, type "point"|"area"|"spot", at, energy, rgb, size, rot_deg}]. A point lamp is 20-60, stove glow',
  'about 15 in orange, window daylight an area light of the window\'s size just inside it, 8-20, facing into',
  'the room (rot_deg [90,0,0] faces -Y from a north window; [-90,0,0] faces +Y). Also blockout.world',
  '{rgb, strength} for what shows through openings.',
  '',
  'Materials: blockout.materials {name: {rgb [r,g,b] 0-1, rough, metal, emit? {rgb, strength}}}, a few, with',
  'the colours the views show. A glowing window or lamp shade gets emit.'
].join('\n');

const BLOCKOUT_EXAMPLE = {
  name: 'Example: a small office',
  dimensions_m: { width: 3.2, depth: 4.0, eave_height: 2.6 },
  anchors: { ANCHOR_stand_door: [0.6, -1.2, 0], ANCHOR_stand_desk: [-0.4, 0.6, 0], ANCHOR_sit_desk: [0, 1.15, 0.45], ANCHOR_window: [0, 2.0, 1.5] },
  set_pieces: { 'the desk': ['Desk'], 'the window': ['Window'], 'the bookshelf': ['Bookshelf'] },
  room_prompt: 'A small office: a desk under the window, a bookshelf on the west wall.',
  blockout: {
    materials: { plaster: { rgb: [0.78, 0.76, 0.7], rough: 0.9 }, oak: { rgb: [0.45, 0.3, 0.16], rough: 0.6 },
      glass: { rgb: [0.7, 0.8, 0.9], rough: 0.1, emit: { rgb: [0.75, 0.85, 1], strength: 1.5 } }, carpet: { rgb: [0.3, 0.3, 0.32], rough: 1 } },
    room: { shape: 'rect', wall: 'plaster', floor: 'carpet', ceiling: 'plaster',
      openings: [{ name: 'Window', wall: 'north', center: 0, bottom: 0.9, width: 1.2, height: 1.2, fill: 'glass', frame: 'oak' },
                 { name: 'Doorway', wall: 'south', center: 0.9, bottom: 0, width: 0.85, height: 2.0, frame: 'oak' }] },
    objects: [
      { name: 'Desk top', shape: 'box', at: [0, 1.5, 0.74], size: [1.4, 0.7, 0.04], material: 'oak' },
      { name: 'Desk leg', shape: 'box', at: [-0.65, 1.2, 0.36], size: [0.05, 0.05, 0.72], material: 'oak', repeat: { count: 2, step: [1.3, 0, 0] } },
      { name: 'Bookshelf', shape: 'box', at: [-1.43, 0, 1.0], size: [0.3, 1.2, 2.0], material: 'oak' }
    ],
    lights: [{ name: 'Window daylight', type: 'area', at: [0, 1.95, 1.5], rot_deg: [90, 0, 0], energy: 15, rgb: [0.8, 0.88, 1], size: 1.2 },
             { name: 'Desk lamp', type: 'point', at: [0.5, 1.6, 1.1], energy: 25, rgb: [1, 0.75, 0.45], size: 0.1 }],
    world: { rgb: [0.6, 0.7, 0.85], strength: 0.5 }
  }
};

/**
 * The first JSON object in a reply. Models wrap it in prose or fences, and now
 * and then close it with a brace too many, so this reads up to the brace that
 * balances the first one rather than to the last brace in the text.
 */
function blockoutJson(text) {
  const t = String(text || '');
  const start = t.indexOf('{');
  if (start < 0) throw new Error('The model did not answer with JSON: ' + t.slice(0, 200));
  let depth = 0;
  let inString = false;
  for (let i = start; i < t.length; i++) {
    const c = t[i];
    if (inString) {
      if (c === '\\') i++;
      else if (c === '"') inString = false;
    } else if (c === '"') inString = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return JSON.parse(t.slice(start, i + 1));
  }
  throw new Error('The model\'s JSON is cut off (' + t.length + ' characters): it may have run out of room.');
}

/**
 * Put a model's location into the shape the builder reads. Models reliably get
 * the content right and the nesting slightly wrong: lights or the world beside
 * blockout instead of inside it, a round room with no depth, anchors as objects.
 */
function blockoutNormalise(loc) {
  const l = Object.assign({}, loc);
  const bo = (l.blockout = Object.assign({}, l.blockout || {}));
  for (const k of ['materials', 'room', 'objects', 'lights', 'world', 'view_from']) {
    if (l[k] !== undefined && bo[k] === undefined) bo[k] = l[k];
    delete l[k];
  }
  const dims = (l.dimensions_m = Object.assign({}, l.dimensions_m || {}));
  if ((bo.room || {}).shape === 'round' && !dims.depth) dims.depth = dims.width;
  const anchors = {};
  for (const [k, v] of Object.entries(l.anchors || {})) {
    const p = Array.isArray(v) ? v : v && Array.isArray(v.at) ? v.at : null;
    if (p && p.length === 3) anchors[/^ANCHOR_/.test(k) ? k : 'ANCHOR_' + k] = p.map(Number);
  }
  l.anchors = anchors;
  const pieces = {};
  for (const [k, v] of Object.entries(l.set_pieces || {})) pieces[k] = Array.isArray(v) ? v.map(String) : [String(v)];
  l.set_pieces = pieces;
  return l;
}

/**
 * What makes a location unbuildable, in words the model can act on. Checked
 * before the render host is asked to build: a small model will sometimes answer
 * with a well-formed reply that has no room in it at all.
 */
function blockoutProblems(loc) {
  const out = [];
  const d = loc.dimensions_m || {};
  const bo = loc.blockout || {};
  if (!(Number(d.width) > 0) || !(Number(d.eave_height) > 0)) out.push('dimensions_m needs width and eave_height in metres');
  if ((bo.room || {}).shape !== 'round' && !(Number(d.depth) > 0)) out.push('a rect room needs dimensions_m.depth');
  const objects = bo.objects || [];
  if (objects.length < 3) out.push(`blockout.objects has ${objects.length} object(s): build the furniture and everything on the walls`);
  const known = new Set(['box', 'cylinder', 'cone', 'torus', 'sphere', 'poly']);
  const odd = objects.filter((o) => !known.has(o && o.shape)).map((o) => (o && o.name) || '?');
  if (odd.length) out.push('these objects have no shape the builder knows: ' + odd.slice(0, 8).join(', '));
  const stands = Object.keys(loc.anchors || {}).filter((k) => /stand/i.test(k));
  if (stands.length < 2) out.push('give at least two ANCHOR_stand_ marks');
  const half = (Number(d.width) || 0) / 2;
  const halfD = (Number(d.depth) || Number(d.width) || 0) / 2;
  const outside = Object.entries(loc.anchors || {}).filter(([, p]) => Math.abs(p[0]) > half || Math.abs(p[1]) > halfD).map(([k]) => k);
  if (half && outside.length) out.push('these marks are outside the walls: ' + outside.join(', '));
  return out;
}

/** The prompt that turns four views of a room into a first block-out. */
function blockoutFirstPrompt(name, notes) {
  return [
    BLOCKOUT_RULES,
    '',
    'Here is a complete example of the format (a different room):',
    JSON.stringify(BLOCKOUT_EXAMPLE),
    '',
    `The images are views N, E, S and W, in that order, of "${name}".`,
    notes ? 'Notes from the director: ' + notes : '',
    '',
    'First look at each view and say what is there and where, then write the location. Answer with JSON only:',
    '{"survey": {"N": "...", "E": "...", "S": "...", "W": "..."}, "location": {name, dimensions_m, anchors,',
    'set_pieces, room_prompt, inferences: ["what you had to guess"], blockout: {...}}}'
  ].join('\n');
}

/** One object per line, rounded, so a revision prompt stays readable and short. */
function blockoutCompact(loc) {
  const bo = loc.blockout || {};
  const r = (v) => (Array.isArray(v) ? v.map(r) : typeof v === 'number' ? Math.round(v * 1000) / 1000 : v);
  const line = (o) => JSON.stringify(Object.fromEntries(Object.entries(o).map(([k, v]) => [k, r(v)])));
  return [
    'dimensions_m: ' + JSON.stringify(loc.dimensions_m),
    'anchors: ' + JSON.stringify(loc.anchors || {}),
    'set_pieces: ' + JSON.stringify(loc.set_pieces || {}),
    'room: ' + JSON.stringify(bo.room || {}),
    'materials: ' + JSON.stringify(bo.materials || {}),
    'world: ' + JSON.stringify(bo.world || {}),
    'view_from: ' + JSON.stringify(bo.view_from || [0, 0, 1.6]),
    'lights:', ...(bo.lights || []).map(line),
    'objects:', ...(bo.objects || []).map((o) => (o.shape === 'poly' ? line({ name: o.name, shape: 'poly', material: o.material, cover: o.cover, vertices: (o.verts || []).length }) : line(o)))
  ].join('\n');
}

/** The prompt for the next revision: the reference, the block-out as built, and what is wrong with it. */
function blockoutRevisePrompt(loc, feedback, hasReference) {
  return [
    BLOCKOUT_RULES,
    '',
    hasReference
      ? 'Images 1-4 are the reference views N, E, S, W. Images 5-8 are the block-out as built, rendered from the same place in the same four directions. Image 9 is its plan from above, north up.'
      : 'Images 1-4 are the block-out as built, views N, E, S, W from the middle of the room. Image 5 is its plan from above, north up.',
    '',
    `The location "${loc.name}" as it stands (revision ${loc.revision}):`,
    blockoutCompact(loc),
    '',
    'What needs fixing:',
    feedback.length ? feedback.map((f) => '- ' + f).join('\n') : '- Nothing reported: compare the block-out with ' + (hasReference ? 'the reference' : 'what the room should be') + ' and fix what is most wrong.',
    '',
    hasReference ? 'Compare each built view with its reference view: what is missing, in the wrong place, the wrong size or the wrong colour.' : '',
    'Answer with JSON only, a change to apply, not the whole location:',
    '{"compare": {"N": "...", "E": "...", "S": "...", "W": "..."}, "change_note": "one line: what this revision changes",',
    ' "remove": ["object names"], "update": [{"name": "...", ...fields to change}], "add": [new objects],',
    ' "lights": [every light, only if they change], "materials": {new or changed}, "room": {fields to change},',
    ' "dimensions_m": {only if wrong}, "anchors": {new or moved}, "set_pieces": {new or changed},',
    ' "view_from": [x, y, z] only if the views show the panorama was taken somewhere else}'
  ].join('\n');
}

/** Apply a revision's change to a location. Returns the new location; the old one is untouched. */
function blockoutApply(loc, change) {
  const next = JSON.parse(JSON.stringify(loc));
  const bo = (next.blockout = next.blockout || {});
  bo.objects = bo.objects || [];
  const gone = new Set((change.remove || []).map(String));
  // A name removes the object, and the numbered copies a repeat made of it.
  bo.objects = bo.objects.filter((o) => !gone.has(o.name));
  for (const u of change.update || []) {
    const o = bo.objects.find((x) => x.name === u.name);
    if (o) Object.assign(o, u);
    else if (u.shape) bo.objects.push(u);
  }
  const names = new Set(bo.objects.map((o) => o.name));
  for (const a of change.add || []) {
    if (!a || !a.shape) continue;
    let n = a.name || a.shape;
    for (let i = 2; names.has(n); i++) n = `${a.name} ${i}`;
    names.add(n);
    bo.objects.push(Object.assign({}, a, { name: n }));
  }
  if (Array.isArray(change.lights)) bo.lights = change.lights;
  if (change.materials) bo.materials = Object.assign({}, bo.materials, change.materials);
  if (change.room) bo.room = Object.assign({}, bo.room, change.room);
  if (change.world) bo.world = change.world;
  if (Array.isArray(change.view_from) && change.view_from.length === 3) bo.view_from = change.view_from;
  if (change.dimensions_m) next.dimensions_m = Object.assign({}, next.dimensions_m, change.dimensions_m);
  if (change.anchors) next.anchors = Object.assign({}, next.anchors, change.anchors);
  if (change.set_pieces) next.set_pieces = Object.assign({}, next.set_pieces, change.set_pieces);
  next.change = change.change_note || '';
  next.parent_revision = loc.revision;
  return next;
}

/** The revision after the highest one a location has: v001, v002 ... */
function blockoutNextRevision(existing) {
  const n = Math.max(0, ...existing.map((r) => parseInt(String(r).replace(/^v/, ''), 10) || 0));
  return 'v' + String(n + 1).padStart(3, '0');
}
