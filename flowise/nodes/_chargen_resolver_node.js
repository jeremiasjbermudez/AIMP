// The project this run is for. The app sends `--movie <id>`; without one (a
// script, a run typed into Flowise) the active movie is used, as before.
const requestedMovieId = ((/--movie\s+([0-9a-f-]{36})/i.exec(String($flow.input || '')) || [])[1]) || '';
const rawInput = (String($flow.input || '').replace(/--movie\s+\S+/gi, '')).trim();
const typeMatch = /--type\s+(\S+)/i.exec(rawInput);
const requestedType = typeMatch ? typeMatch[1] : null;
// --version N writes into that image version instead of overwriting v1,
// so a regenerate sits beside the previous attempt rather than replacing it.
const versionMatch = /--version\s+(\d+)/i.exec(rawInput);
const targetVersion = versionMatch ? parseInt(versionMatch[1], 10) : 1;
// Read before the name is cleaned; stripping it first would lose the request.
// The later steps regenerate an existing character's images only when forced.
const force = /--force\b/i.test(rawInput);
// Flags that take a value go first, then any remaining bare flag.
// Stripping only "--flag value" pairs left a trailing --force in the name.
const characterName = rawInput
  .replace(/--(?:type|version)\s+\S+/gi, '')
  .replace(/--[\w-]+/g, '')
  .replace(/\s+/g, ' ')
  .trim()
  .toUpperCase();
if (!characterName) {
  return { error: 'No character name provided. Character-Generator expects a plain character name as input (e.g. "CHARACTER" or "CHARACTER --type closeup").' };
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

const existingRes = await axios.get(`${insforgeUrl}/api/database/records/characters`, {
  params: { movie_id: `eq.${movieId}`, name: `eq.${characterName}`, select: '*' },
  headers: authHeaders
});
const existing = (existingRes.data || [])[0] || null;

let characterId;
let isNewCharacter;
if (existing) {
  characterId = existing.id;
  isNewCharacter = false;
} else {
  const insertRes = await axios.post(
    `${insforgeUrl}/api/database/records/characters`,
    { movie_id: movieId, name: characterName },
    { headers: { ...authHeaders, 'Content-Type': 'application/json', Prefer: 'return=representation' } }
  );
  characterId = insertRes.data[0].id;
  isNewCharacter = true;
}

return {
  targetVersion,
  movieId,
  movieTitle,
  movieSlug,
  bucketName,
  characterId,
  characterName,
  isNewCharacter,
  existingCharacter: existing,
  requestedType,
  force
};
