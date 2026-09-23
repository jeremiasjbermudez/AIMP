// The project this run is for. The app sends `--movie <id>`; without one (a
// script, a run typed into Flowise) the active movie is used, as before.
const requestedMovieId = ((/--movie\s+([0-9a-f-]{36})/i.exec(String($flow.input || '')) || [])[1]) || '';
const scopeInput = (String($flow.input || '').replace(/--movie\s+\S+/gi, '')).trim();
const scopeMatch = /^A(\d+)(?:S(\d+)(?:B(\d+))?)?$/i.exec(scopeInput);
if (!scopeMatch) {
  return { error: `Could not parse scope "${scopeInput}". Expected A<act>, A<act>S<scene>, or A<act>S<scene>B<beat> - e.g. A1, A1S2, A1S2B4.` };
}
const scope = {
  act: parseInt(scopeMatch[1], 10),
  scene: scopeMatch[2] ? parseInt(scopeMatch[2], 10) : null,
  beat: scopeMatch[3] ? parseInt(scopeMatch[3], 10) : null
};

const axios = require('axios');
const insforgeUrl = $insforgeUrl;
const insforgeApiKey = $insforgeApiKey;
const authHeaders = { Authorization: `Bearer ${insforgeApiKey}` };

const activeRes = await axios.get(`${insforgeUrl}/api/database/records/movies`, {
  params: requestedMovieId ? { id: `eq.${requestedMovieId}`, select: 'id,bucket_name,title' } : { is_active: 'eq.true', select: 'id,bucket_name,title' },
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

const docsRes = await axios.get(`${insforgeUrl}/api/database/records/documents`, {
  params: { movie_id: `eq.${movieId}`, kind: 'eq.screenplay', select: 'id,storage_key,original_filename' },
  headers: authHeaders
});
const docs = docsRes.data || [];
if (docs.length === 0) {
  return { error: 'No screenplay document found for this movie (kind=screenplay). Upload one first.' };
}
if (docs.length > 1) {
  return { error: `Found ${docs.length} screenplay documents for this movie - ambiguous which is current.` };
}
const doc = docs[0];

const key = encodeURIComponent(doc.storage_key);
const strategyRes = await axios.get(`${insforgeUrl}/api/storage/buckets/${bucketName}/download-strategy/objects/${key}`, {
  headers: authHeaders
});
const strategy = strategyRes.data;
const fileHeaders = strategy.method === 'direct' ? authHeaders : {};
const fileRes = await axios.get(strategy.url, { headers: fileHeaders, transformResponse: (r) => r });
const screenplayText = fileRes.data;

return {
  scope,
  movieId,
  movieTitle,
  bucketName,
  documentId: doc.id,
  originalFilename: doc.original_filename,
  screenplayLength: screenplayText.length,
  screenplayText
};
