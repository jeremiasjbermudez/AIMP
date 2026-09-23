// The project this run is for. The app sends `--movie <id>`; without one (a
// script, a run typed into Flowise) the active movie is used, as before.
const requestedMovieId = ((/--movie\s+([0-9a-f-]{36})/i.exec(String($flow.input || '')) || [])[1]) || '';
const rawInput = (String($flow.input || '').replace(/--movie\s+\S+/gi, '')).trim();
// --force forces all three downstream stages; --force-characters / --force-pano /
// --force-world force just that one. Stripped out before the scope regex match
// below (which requires the whole remaining string to be a bare A/S/B token).
const forceAll = /--force\b(?!-)/i.test(rawInput);
const forceCharacters = forceAll || /--force-characters\b/i.test(rawInput);
const forcePano = forceAll || /--force-pano\b/i.test(rawInput);
const forceWorld = forceAll || /--force-world\b/i.test(rawInput);
const scopeInput = rawInput.replace(/--force(-\w+)?\b/gi, '').trim();
const scopeMatch = /^A(\d+)(?:S(\d+)(?:B(\d+))?)?$/i.exec(scopeInput);
if (!scopeMatch) {
  return { error: `Could not parse scope "${scopeInput}". Expected A<act>, A<act>S<scene>, or A<act>S<scene>B<beat> - e.g. A1, A1S2, A1S2B4.`, characterNames: [] };
}
const scope = {
  act: parseInt(scopeMatch[1], 10),
  scene: scopeMatch[2] ? parseInt(scopeMatch[2], 10) : null,
  beat: scopeMatch[3] ? parseInt(scopeMatch[3], 10) : null
};

const axios = require('axios');
const authHeaders = { Authorization: `Bearer ${$insforgeApiKey}` };

// Which movie this runs against is never hardcoded - same dynamic lookup as
// 1-Beat-Generator, follows whatever is currently selected in the
// pipeline-admin app.
const activeRes = await axios.get(`${$insforgeUrl}/api/database/records/movies`, {
  params: requestedMovieId ? { id: `eq.${requestedMovieId}`, select: 'id,title' } : { is_active: 'eq.true', select: 'id,title' },
  headers: authHeaders
});
const activeMovies = activeRes.data || [];
if (activeMovies.length === 0) {
  return { error: (requestedMovieId ? `Project ${requestedMovieId} not found.` : 'No active movie set. Select one in the pipeline-admin app first.'), characterNames: [] };
}
if (activeMovies.length > 1) {
  return { error: `Found ${activeMovies.length} active movies - this should be impossible (unique index should prevent it).`, characterNames: [] };
}
const movieId = activeMovies[0].id;
const movieTitle = activeMovies[0].title;

const params = {
  movie_id: `eq.${movieId}`,
  act_number: `eq.${scope.act}`,
  select: 'id,beat_code,scene_number,beat_number,characters'
};
if (scope.scene != null) params.scene_number = `eq.${scope.scene}`;
if (scope.beat != null) params.beat_number = `eq.${scope.beat}`;

const beatsRes = await axios.get(`${$insforgeUrl}/api/database/records/beats`, {
  params,
  headers: authHeaders
});
const beats = beatsRes.data || [];

if (beats.length === 0) {
  const label = 'A' + scope.act + (scope.scene != null ? 'S' + scope.scene : '') + (scope.beat != null ? 'B' + scope.beat : '');
  return { error: `No beats found for scope ${label} in "${movieTitle}". Run 1-Beat-Generator for this scope first.`, characterNames: [] };
}

// Unique character names across every matched beat, in first-seen order.
const seen = new Set();
const characterNames = [];
for (const beat of beats) {
  for (const c of beat.characters || []) {
    if (!seen.has(c.name)) {
      seen.add(c.name);
      characterNames.push(c.name);
    }
  }
}

// Unique scene numbers in scope, for the Panoramic-Generator/World-Builder
// fork - a pre-scene beat (scene_number null, e.g. an opening title
// sequence with no heading yet) has no room to generate a pano/splat for,
// so it's excluded.
const seenScenes = new Set();
const sceneScopes = [];
for (const beat of beats) {
  if (beat.scene_number == null) continue;
  if (!seenScenes.has(beat.scene_number)) {
    seenScenes.add(beat.scene_number);
    sceneScopes.push('A' + scope.act + 'S' + beat.scene_number);
  }
}

return {
  scope,
  movieId,
  movieTitle,
  beatCount: beats.length,
  beatCodes: beats.map((b) => b.beat_code),
  characterNames,
  sceneScopes,
  force: { characters: forceCharacters, pano: forcePano, world: forceWorld }
};
