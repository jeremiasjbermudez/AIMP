// The project this run is for. The app sends `--movie <id>`; without one (a
// script, a run typed into Flowise) the active movie is used, as before.
const requestedMovieId = ((/--movie\s+([0-9a-f-]{36})/i.exec(String($flow.input || '')) || [])[1]) || '';
const raw = (String($flow.input || '').replace(/--movie\s+\S+/gi, '')).toString();
const force = /--force\b/i.test(raw);

// ------------------------------------------------------------ build options
//
// How hard the world builder should look at the room. The defaults are what it
// has always done - no exploration at all - so every existing caller ("A1S2",
// "A1S2 --force") behaves exactly as before and nothing had to be changed to
// keep working.
//
// Why this matters: with exploration off, WorldStereo only expands along the
// base trajectory set. It never travels to the corners, so no view ever
// constrains the gaussians there and a camera placed in one renders smear. The
// A1S2 rebuild with nav + anchor scans on took the fused geometry from 1 MB to
// 20 MB and came back sharp from every bearing.
//
// Read as flags so the whole contract stays a string, like every other flow
// here: "A1S2 --force --quality detailed --anchors 3 --max-traj 20".
const numFlag = (name, fallback) => {
  const m = new RegExp('--' + name + '[= ]+(\\d+)', 'i').exec(raw);
  return m ? parseInt(m[1], 10) : fallback;
};
const qualityMatch = /--quality[= ]+(fast|standard|detailed|exhaustive)/i.exec(raw);
const quality = qualityMatch ? qualityMatch[1].toLowerCase() : 'standard';

// Presets, in what they cost rather than what they promise. Trajectories are
// the expensive axis: every one is a run of WorldStereo generations plus the
// WorldMirror reconstructions that follow, so max_trajectories is the dial that
// decides whether this is twenty minutes or three hours.
const PRESETS = {
  fast:       { nav: false, detail: false, anchors: 0, maxTraj: 4,  steps: 5001 },
  standard:   { nav: true,  detail: false, anchors: 3, maxTraj: 14, steps: 5001 },
  detailed:   { nav: true,  detail: true,  anchors: 4, maxTraj: 28, steps: 9001 },
  exhaustive: { nav: true,  detail: true,  anchors: 6, maxTraj: 0,  steps: 15001 }
};
const preset = PRESETS[quality] || PRESETS.standard;

// Anything named explicitly wins over the preset, so "--quality fast --anchors 5"
// means what it says instead of silently keeping the preset's 0.
// "--resume" continues training the scene's EXISTING world from the checkpoint
// its last build saved, instead of training from scratch. Trajectories that
// already exist are reused (that cache is by folder), new ones are expanded,
// and the trainer picks up where it stopped - same coordinate frame, so the
// floor plan and every shot camera placed in the old splat still hold. With
// --resume, --steps means how many MORE steps (default 2000), not the total.
const resume = /--resume\b/i.test(raw);

const build = {
  quality,
  resume,
  navTraj: /--no-nav\b/i.test(raw) ? false : /--nav\b/i.test(raw) ? true : preset.nav,
  detailTraj: /--no-detail\b/i.test(raw) ? false : /--detail\b/i.test(raw) ? true : preset.detail,
  anchors: numFlag('anchors', preset.anchors),
  maxTraj: numFlag('max-traj', preset.maxTraj),
  steps: numFlag('steps', resume ? 2001 : preset.steps),
  detailObjects: numFlag('detail-objects', 6),
  seed: numFlag('seed', 1),
  // "--workspace <name>" builds into an EXISTING workspace folder instead of
  // the derived Act/Scene/location name. Needed when a world was explored
  // under another name and its trajectories, floor plan and cameras all live
  // there: rebuilding under the derived name would start a different world
  // from scratch and leave every camera pointing at the old one.
  workspace: (/--workspace[= ]+([A-Za-z0-9_-]+)/i.exec(raw) || [])[1] || null,
  // "--panorama <path under C:/ComfyUI2>" builds from THAT image instead of
  // the scene's newest panorama record. A world's trajectory cache is keyed
  // on the panorama it was built from; if the record has since been replaced
  // (A1S2's was re-uploaded after its world was explored) the newest record
  // is a different picture, the cache misses, and the rebuild silently makes
  // a different world. The workspace's own panorama.png is the truth for it.
  panorama: (/--panorama[= ]+(\S+)/i.exec(raw) || [])[1] || null
};

let act, sceneNumber;
const actSceneMatch = /^A(\d+)S(\d+)/i.exec(raw.trim());
if (actSceneMatch) {
  act = parseInt(actSceneMatch[1], 10);
  sceneNumber = parseInt(actSceneMatch[2], 10);
} else {
  const bare = /(\d+)/.exec(raw.replace(/--\w+\s*/gi, ''));
  sceneNumber = bare ? parseInt(bare[1], 10) : null;
}
if (!sceneNumber) {
  return { error: 'Could not parse a scene number from input. Expected "A1S2" or a bare scene number like "2", optionally with --force.' };
}

const axios = require('axios');
const insforgeUrl = $insforgeUrl;
const insforgeApiKey = $insforgeApiKey;
const authHeaders = { Authorization: `Bearer ${insforgeApiKey}` };

const activeRes = await axios.get(`${insforgeUrl}/api/database/records/movies`, {
  params: requestedMovieId ? { id: `eq.${requestedMovieId}`, select: 'id,bucket_name,title,slug' } : { is_active: 'eq.true', select: 'id,bucket_name,title,slug' },
  headers: authHeaders
});
const activeMovies = activeRes.data || [];
if (activeMovies.length === 0) {
  return { error: (requestedMovieId ? `Project ${requestedMovieId} not found.` : 'No active movie set. Select one in the pipeline-admin app first.') };
}
if (activeMovies.length > 1) {
  return { error: `Found ${activeMovies.length} active movies - this should be impossible.` };
}
const movieId = activeMovies[0].id;
const bucketName = activeMovies[0].bucket_name;
const movieTitle = activeMovies[0].title;
const movieSlug = activeMovies[0].slug;

if (act == null) {
  const sceneRes = await axios.get(`${insforgeUrl}/api/database/records/scenes`, {
    params: { movie_id: `eq.${movieId}`, scene_number: `eq.${sceneNumber}`, select: 'act_number', limit: 1 },
    headers: authHeaders
  });
  const scene = (sceneRes.data || [])[0];
  if (!scene) {
    return { error: `No scene row found with scene_number ${sceneNumber} for this movie in the scenes table. Add it first, or check the scene number.` };
  }
  act = scene.act_number;
}

// World Builder reconstructs FROM a scene's own panorama - it can't run
// before Panoramic-Generator has produced one.
const panoRes = await axios.get(`${insforgeUrl}/api/database/records/scene_panos`, {
  params: { movie_id: `eq.${movieId}`, act_number: `eq.${act}`, scene_number: `eq.${sceneNumber}`, select: 'image_path' },
  headers: authHeaders
});
const pano = build.panorama ? { image_path: build.panorama } : (panoRes.data || [])[0];
if (!pano) {
  return { error: `No panorama exists yet for A${act}S${sceneNumber}. Run 4-Panoramic-Generator for this scene first.` };
}

// Location name for the workspace folder now comes from the scenes table
// directly, instead of being re-derived from a beat's location field.
const sceneRes2 = await axios.get(`${insforgeUrl}/api/database/records/scenes`, {
  params: { movie_id: `eq.${movieId}`, act_number: `eq.${act}`, scene_number: `eq.${sceneNumber}`, select: 'location_name', limit: 1 },
  headers: authHeaders
});
const locationRaw = ((sceneRes2.data || [])[0] || {}).location_name || '';
const locationSlug = locationRaw
  .replace(/[^A-Za-z0-9]+/g, ' ')
  .split(/\s+/)
  .filter(Boolean)
  .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
  .join('') || 'Unknown';

return { movieId, movieTitle, movieSlug, bucketName, act, sceneNumber, force, panoImagePath: pano.image_path, locationSlug, build };
