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
  params: { id: `eq.${shotId}`, select: 'id,movie_id,act_number,scene_number,raw_capture_path' },
  headers: authHeaders
});
const shot = (shotRes.data || [])[0];
if (!shot) return { error: `No shot found with id ${shotId}.` };
if (!shot.raw_capture_path) return { error: `Shot ${shotId} has no raw_capture_path - upload a camera-angle screenshot first.` };

const panoRes = await axios.get(`${insforgeUrl}/api/database/records/scene_panos`, {
  params: { movie_id: `eq.${shot.movie_id}`, act_number: `eq.${shot.act_number}`, scene_number: `eq.${shot.scene_number}`, select: 'image_path' },
  headers: authHeaders
});
const pano = (panoRes.data || [])[0];
if (!pano) return { error: `No panorama exists yet for A${shot.act_number}S${shot.scene_number}. Run 4-Panoramic-Generator for this scene first.` };

const movieRes = await axios.get(`${insforgeUrl}/api/database/records/movies`, {
  params: { id: `eq.${shot.movie_id}`, select: 'bucket_name,slug' },
  headers: authHeaders
});
const movie = (movieRes.data || [])[0];
if (!movie) return { error: `Movie ${shot.movie_id} not found.` };

return {
  shotId,
  movieId: shot.movie_id,
  bucketName: movie.bucket_name,
  movieSlug: movie.slug,
  rawCapturePath: shot.raw_capture_path,
  panoImagePath: pano.image_path
};
