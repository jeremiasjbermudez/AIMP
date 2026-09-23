// The project this run is for. The app sends `--movie <id>`; without one (a
// script, a run typed into Flowise) the active movie is used, as before.
const requestedMovieId = ((/--movie\s+([0-9a-f-]{36})/i.exec(String($flow.input || '')) || [])[1]) || '';
const raw = (String($flow.input || '').replace(/--movie\s+\S+/gi, '')).toString();
const seedM = raw.match(/--seed\s+(\d+)/i);
const forceM = /--force\b/i.test(raw);
const presetM = raw.match(/--preset\s+(\S[\S ]*?)(?=\s--|$)/i);
const preset = presetM ? presetM[1].trim() : '2048 x 1024';
const seed = seedM ? parseInt(seedM[1], 10) : Math.floor(Math.random() * 1e9);

const actSceneMatch = /^A(\d+)S(\d+)/i.exec(raw.trim());
let act, sceneNumber;
if (actSceneMatch) {
  act = parseInt(actSceneMatch[1], 10);
  sceneNumber = parseInt(actSceneMatch[2], 10);
} else {
  const bare = /(\d+)/.exec(raw.replace(/--\w+\s+\S+/gi, ''));
  sceneNumber = bare ? parseInt(bare[1], 10) : null;
}
if (!sceneNumber) {
  return { error: 'Could not parse a scene number from input. Expected "A1S2" or a bare scene number like "2" (act is resolved from the scenes table when omitted).' };
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

// Act isn't always given explicitly - resolve it from the scenes table
// (the scene's own act_number), rather than requiring it up front.
if (act == null) {
  const sceneRes = await axios.get(`${insforgeUrl}/api/database/records/scenes`, {
    params: { movie_id: `eq.${movieId}`, scene_number: `eq.${sceneNumber}`, select: 'act_number', limit: 1 },
    headers: authHeaders
  });
  const scene = (sceneRes.data || [])[0];
  if (!scene) {
    return { error: `No scene row found with scene_number ${sceneNumber} for this movie in the scenes table. Add it first (or check the scene number).` };
  }
  act = scene.act_number;
}

return { movieId, movieTitle, movieSlug, bucketName, act, sceneNumber, seed, force: forceM, preset };
