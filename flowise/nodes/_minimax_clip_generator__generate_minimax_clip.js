const resolved = JSON.parse($resolveOutput);
if (resolved.error) return { error: resolved.error };

const { shotId, movieSlug, cleanedImagePath, referenceImagePaths, promptText, lengthFrames, extraReferencePaths, bucketName } = resolved;

const axios = require('axios');
const insforgeUrl = $insforgeUrl;
const insforgeApiKey = $insforgeApiKey;
const comfyUrl = $comfyUrl;
const authHeaders = { Authorization: `Bearer ${insforgeApiKey}` };
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

async function updateShot(patch) {
  await axios.patch(`${insforgeUrl}/api/database/records/shots`, patch, {
    params: { id: `eq.${shotId}` },
    headers: { ...authHeaders, 'Content-Type': 'application/json', Prefer: 'return=minimal' }
  });
}

await updateShot({ status: 'rendering', error_message: null });

const waitFor = async (pid, maxTries, everyMs) => {
  for (let k = 0; k < maxTries; k++) {
    await sleep(everyMs);
    try {
      const h = await axios.get(comfyUrl + '/history/' + pid);
      const rec = h && h.data && h.data[pid];
      if (rec && rec.status && rec.status.status_str) return rec;
    } catch (e) {}
  }
  return null;
};

// Duration (seconds) -> frame length on MiniMax H3's 17k+5 grid. Exact same
// formula the official template's own ComfyMathExpression node uses.
// The admin UI estimates this from the beat's dialogue and stores it already
// snapped to the 17k+5 grid, so the flow just honours it. The 124-frame
// fallback (the official template's 5s default) covers rows created before
// length_frames existed, and anything the UI left unset.
const length = Number(lengthFrames) > 0 ? Number(lengthFrames) : 124;

// Matches the official template's own ResolutionSelector default (16:9
// Widescreen, 0.4 megapixels, multiple 32) exactly.
const width = 864;
const height = 480;

function buildMultipart(fields) {
  const boundary = '----FlowiseMiniMaxStage' + Math.random().toString(16).slice(2);
  const parts = [];
  for (const [name, value] of Object.entries(fields)) {
    if (Buffer.isBuffer(value.data)) {
      parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"; filename="${value.filename}"\r\nContent-Type: ${value.contentType}\r\n\r\n`));
      parts.push(value.data);
      parts.push(Buffer.from('\r\n'));
    } else {
      parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`));
    }
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  return { body: Buffer.concat(parts), boundary };
}

// The official template's two reference-image nodes are plain LoadImage,
// which reads by filename from ComfyUI's input/ folder - not JWImageLoadRGB
// with an absolute path (an earlier version of this file used JWImageLoadRGB
// throughout, a real structural difference from the proven graph). Character
// reference images already live under input/, so they can be used as-is;
// the cleaned camera-angle image lives under output/ (Qwen cleanup's
// SaveImage), so it needs staging into input/ first via ComfyUI's own
// /upload/image - done as its own submission, since a single /prompt graph
// has no way to force a copy step to run before a plain LoadImage node
// (LoadImage takes no input link, so nothing would order them correctly).
async function stageIntoInput(absOutputPath, stagedRelPath) {
  const parts = absOutputPath.replace(/\\/g, '/').split('/output/');
  const readRes = await axios.get(comfyUrl + '/view', {
    params: { filename: parts[1].split('/').pop(), subfolder: parts[1].split('/').slice(0, -1).join('/'), type: 'output' },
    responseType: 'arraybuffer'
  });
  const relParts = stagedRelPath.split('/');
  const stagedFilename = relParts.pop();
  const stagedSubfolder = relParts.join('/');
  const { body, boundary } = buildMultipart({
    type: 'input', subfolder: stagedSubfolder, overwrite: 'true',
    image: { data: Buffer.from(readRes.data), filename: stagedFilename, contentType: 'image/png' }
  });
  const upRes = await axios.post(comfyUrl + '/upload/image', body, { headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` } });
  if (upRes.status < 200 || upRes.status >= 300) throw new Error('Staging cleaned image into input/ failed: ' + JSON.stringify(upRes.data).slice(0, 300));
  return stagedRelPath;
}

const cleanedStagedRel = movieSlug + '/_minimax_clips/staged/shot_' + shotId + '_picture1.png';
await stageIntoInput(String($comfyRoot || 'C:/ComfyUI2').replace(/[\\/]+$/, '') + '/' + cleanedImagePath, cleanedStagedRel);

// ref_images[0] = the cleaned camera-angle/background render (Picture 1),
// then each selected character reference in order (Picture 2, 3, ...).
// Filenames relative to input/, matching plain LoadImage's own convention -
// character_images.image_path is already stored as "input/...".
// Ad-hoc references the operator attached to this shot. They live in InsForge
// storage, so each is pulled down and staged into ComfyUI's input/ folder the
// same way the cleaned plate is.
const extraStagedRels = [];
for (let xi = 0; xi < (extraReferencePaths || []).length; xi++) {
  const storageKey = extraReferencePaths[xi];
  try {
    const strategyRes = await axios.get(`${insforgeUrl}/api/storage/buckets/${bucketName}/download-strategy/objects/${encodeURIComponent(storageKey)}`, { headers: authHeaders });
    const strategy = strategyRes.data;
    const fileHeaders = strategy.method === 'direct' ? authHeaders : {};
    const fileRes = await axios.get(strategy.url, { headers: fileHeaders, responseType: 'arraybuffer' });
    const rel = movieSlug + '/_minimax_clips/staged/shot_' + shotId + '_extra' + xi + '.png';
    const relParts = rel.split('/');
    const stagedFilename = relParts.pop();
    const stagedSubfolder = relParts.join('/');
    const { body, boundary } = buildMultipart({ type: 'input', subfolder: stagedSubfolder, overwrite: 'true', image: { data: Buffer.from(fileRes.data), filename: stagedFilename, contentType: 'image/png' } });
    const upRes = await axios.post(comfyUrl + '/upload/image', body, { headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` } });
    if (upRes.status >= 200 && upRes.status < 300) extraStagedRels.push(rel);
  } catch (e) {
    const msg = 'Extra reference image could not be staged: ' + (e && e.message ? e.message : String(e));
    await updateShot({ status: 'failed', error_message: msg });
    return { action: 'error', reason: msg };
  }
}

const allRefRelPaths = [cleanedStagedRel, ...referenceImagePaths.map((p) => p.replace(/^input\//, ''))];
allRefRelPaths.push(...extraStagedRels);
// MiniMaxH3ReferenceToVideo takes at most 9 references. Report the shortfall
// rather than truncating silently - a reference the operator attached and never
// saw used is worse than being told it did not fit.
const droppedRefs = Math.max(0, allRefRelPaths.length - 9);
if (allRefRelPaths.length > 9) allRefRelPaths.length = 9;

// Node-for-node translation of the actual official R2V template
// (minimax_h3_r2v.json, id e3f2b845-8f2c-4b5a-9caf-eac1029d3e7e, shipped
// locally in ComfyUI's own workflows folder and confirmed working as-is by
// direct manual test) - not an approximation from documentation. Kept
// identical on every setting that isn't inherently per-shot data: sampler
// res_multistep, scheduler simple, 20 steps (turbo LoRA off, matching the
// template's own default), no SigmaShift (not present in the official
// graph), ref_image_size "match" (not "max" - an earlier version of this
// file changed this without it being part of the proven template), LoadImage
// (not JWImageLoadRGB) for references, CreateVideo+SaveVideo (not
// VHS_VideoCombine) for output.
const g = {
  '119': { class_type: 'VAELoader', inputs: { vae_name: 'minimax_h3_video_vae_fp16.safetensors' } },
  '120': { class_type: 'VAELoader', inputs: { vae_name: 'minimax_h3_audio_vae_fp32.safetensors' } },
  '127': { class_type: 'UNETLoader', inputs: { unet_name: 'minimax_h3_ref2va_pruned_int8_convrot.safetensors', weight_dtype: 'default' } },
  '128': { class_type: 'CLIPLoader', inputs: { clip_name: 'qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors', type: 'minimax', device: 'default' } },
  '129': { class_type: 'RandomNoise', inputs: { noise_seed: Math.floor(Math.random() * 1e15) } },
  '123': { class_type: 'KSamplerSelect', inputs: { sampler_name: 'res_multistep' } },
  '124': { class_type: 'BasicScheduler', inputs: { model: ['127', 0], scheduler: 'simple', steps: 20, denoise: 1 } },
  '126': { class_type: 'BasicGuider', inputs: { model: ['127', 0], conditioning: ['136', 0] } },
  '125': { class_type: 'SamplerCustomAdvanced', inputs: { noise: ['129', 0], guider: ['126', 0], sampler: ['123', 0], sigmas: ['124', 0], latent_image: ['136', 1] } },
  '122': { class_type: 'VAEDecode', inputs: { samples: ['125', 0], vae: ['119', 0] } },
  '121': { class_type: 'VAEDecodeAudio', inputs: { samples: ['125', 0], vae: ['120', 0] } },
  '130': { class_type: 'CreateVideo', inputs: { images: ['122', 0], audio: ['121', 0], fps: 24, bit_depth: 8 } },
  '92': { class_type: 'SaveVideo', inputs: { video: ['130', 0], filename_prefix: movieSlug + '/_minimax_clips/shot_' + shotId, format: 'auto', codec: 'auto' } }
};

const refImageInputs = {};
allRefRelPaths.forEach((relPath, i) => {
  const nodeId = 'ref_' + i;
  g[nodeId] = { class_type: 'LoadImage', inputs: { image: relPath } };
  // ref_images is COMFY_AUTOGROW_V3. In /prompt API format its slots are
  // addressed by flat dotted keys on the node's own inputs - a nested
  // { ref_image_0: [...] } object is read as a plain value, so the link is
  // never made and the LoadImage nodes sit unconnected.
  refImageInputs['ref_images.ref_image_' + i] = [nodeId, 0];
});

g['136'] = {
  class_type: 'MiniMaxH3ReferenceToVideo',
  inputs: {
    clip: ['128', 0],
    vae: ['119', 0],
    audio_vae: ['120', 0],
    prompt: promptText,
    width, height, length,
    ref_image_size: 'match',
    ...refImageInputs
  }
};

const r = await axios.post(comfyUrl + '/prompt', { prompt: g });
const pid = r && r.data && r.data.prompt_id;
if (!pid) {
  const msg = 'MiniMax enqueue failed: ' + JSON.stringify((r && r.data && r.data.node_errors) || (r && r.data)).slice(0, 1500);
  await updateShot({ status: 'failed', error_message: msg });
  return { action: 'error', reason: msg };
}

// Untested pipeline (first-ever run of MiniMaxH3ReferenceToVideo here) - generous poll window.
const rec = await waitFor(pid, 240, 10000);
if (!rec) {
  return { action: 'pending', reason: 'MiniMax generation still running past the check window.', promptId: pid };
}
if (rec.status.status_str === 'error') {
  const msg = 'MiniMax generation failed in ComfyUI: ' + JSON.stringify(rec.status.messages).slice(0, 1500);
  await updateShot({ status: 'failed', error_message: msg });
  return { action: 'error', reason: msg };
}

let outRel = null;
const outputs = rec.outputs || {};
for (const nid in outputs) {
  const o = outputs[nid];
  // SaveVideo (the official template's own output node) writes under
  // "images", confirmed against a real completed history entry - not
  // "gifs"/"videos" as VHS_VideoCombine (the node this file used before) does.
  const candidates = o.images || o.gifs || o.videos || [];
  if (candidates[0]) {
    const f = candidates[0];
    outRel = (f.subfolder ? f.subfolder + '/' : '') + f.filename;
  }
}
if (!outRel) {
  const msg = 'MiniMax generation produced no output video (raw outputs: ' + JSON.stringify(outputs).slice(0, 800) + ')';
  await updateShot({ status: 'failed', error_message: msg });
  return { action: 'error', reason: msg };
}

const videoPath = 'output/' + outRel;
await updateShot({ status: 'complete', video_path: videoPath, error_message: null });

return { action: 'complete', shotId, videoPath, promptId: pid };
