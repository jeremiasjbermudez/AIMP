const rawInput = ($flow.input || '').toString();
let parsed;
try { parsed = JSON.parse(rawInput); } catch (e) {
  return { error: 'Expected JSON input {"shotId": "<uuid>"}, got: ' + rawInput };
}
const shotId = parsed.shotId;
if (!shotId) return { error: 'Missing shotId in input.' };

const axios = require('axios');
const insforgeUrl = $insforgeUrl;
const insforgeApiKey = $insforgeApiKey;
const authHeaders = { Authorization: `Bearer ${insforgeApiKey}` };

const shotRes = await axios.get(`${insforgeUrl}/api/database/records/shots`, {
  params: { id: `eq.${shotId}`, select: 'id,movie_id,cleaned_image_path,prompt_text,reference_character_image_ids,status,length_frames,extra_reference_paths' },
  headers: authHeaders
});
const shot = (shotRes.data || [])[0];
if (!shot) return { error: `No shot found with id ${shotId}.` };
if (!shot.cleaned_image_path) return { error: `Shot ${shotId} has no cleaned_image_path yet - run 6-GS-Cleaner first.` };
if (!shot.prompt_text || !shot.prompt_text.trim()) return { error: `Shot ${shotId} has no prompt_text - write/save a prompt before submitting for video.` };

const movieRes = await axios.get(`${insforgeUrl}/api/database/records/movies`, {
  params: { id: `eq.${shot.movie_id}`, select: 'slug,bucket_name' },
  headers: authHeaders
});
const movie = (movieRes.data || [])[0];
if (!movie) return { error: `Movie ${shot.movie_id} not found.` };

const refIds = Array.isArray(shot.reference_character_image_ids) ? shot.reference_character_image_ids : [];
const referenceImagePaths = [];
for (const refId of refIds) {
  const ciRes = await axios.get(`${insforgeUrl}/api/database/records/character_images`, {
    params: { id: `eq.${refId}`, select: 'image_path' },
    headers: authHeaders
  });
  const ci = (ciRes.data || [])[0];
  if (!ci) return { error: `character_images row ${refId} referenced by shot ${shotId} no longer exists.` };
  referenceImagePaths.push(ci.image_path);
}

return {
  shotId,
  movieSlug: movie.slug,
  cleanedImagePath: shot.cleaned_image_path,
  referenceImagePaths,
  promptText: shot.prompt_text,
  lengthFrames: shot.length_frames,
  extraReferencePaths: Array.isArray(shot.extra_reference_paths) ? shot.extra_reference_paths : [],
  bucketName: movie.bucket_name
};
