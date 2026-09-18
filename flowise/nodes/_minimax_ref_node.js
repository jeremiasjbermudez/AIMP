// Reference to Video, rebuilt against minimax_clips so the tab behaves like
// Image/Text to Video: one row per generation, no takes, no redo chain, and no
// Qwen cleanup step (that is done by hand now, and the cleaned image is simply
// picked as one of the references).
//
// The ComfyUI graph below is a node-for-node copy of the proven R2V template
// already used by 7-MiniMax-Clip-Generator. Nothing about the render changed -
// only where the inputs come from.
const axios = require('axios');
const insforgeUrl = $insforgeUrl;
const insforgeApiKey = $insforgeApiKey;
const comfyUrl = $comfyUrl;
const authHeaders = { Authorization: `Bearer ${insforgeApiKey}` };
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

let parsed;
try {
  parsed = JSON.parse(($flow.input || '').toString());
} catch (e) {
  return { error: 'Expected JSON input {"clipId": "<uuid>"}.' };
}
const clipId = parsed.clipId;
if (!clipId) return { error: 'Missing clipId.' };

const clipRes = await axios.get(`${insforgeUrl}/api/database/records/minimax_clips`, {
  params: { id: `eq.${clipId}`, select: '*' },
  headers: authHeaders
});
const clip = (clipRes.data || [])[0];
if (!clip) return { error: `No clip found with id ${clipId}.` };

const refs = Array.isArray(clip.reference_image_paths) ? clip.reference_image_paths : [];
if (!refs.length) return { error: 'Pick at least one reference image before generating.' };
if (!clip.prompt || !clip.prompt.trim()) return { error: 'This clip has no prompt.' };

const movieRes = await axios.get(`${insforgeUrl}/api/database/records/movies`, {
  params: { id: `eq.${clip.movie_id}`, select: 'slug,bucket_name' },
  headers: authHeaders
});
const movie = (movieRes.data || [])[0];
if (!movie) return { error: 'Movie not found.' };

async function updateClip(patch) {
  await axios.patch(`${insforgeUrl}/api/database/records/minimax_clips`, patch, {
    params: { id: `eq.${clipId}` },
    headers: { ...authHeaders, 'Content-Type': 'application/json', Prefer: 'return=minimal' }
  });
}

await updateClip({ status: 'rendering', error_message: null });

function buildMultipart(fields) {
  const boundary = '----flowise' + Date.now();
  const parts = [];
  for (const key of Object.keys(fields)) {
    const v = fields[key];
    if (v && v.data) {
      parts.push(Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${key}"; filename="${v.filename}"\r\n` +
        `Content-Type: ${v.contentType}\r\n\r\n`));
      parts.push(v.data);
      parts.push(Buffer.from('\r\n'));
    } else {
      parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${v}\r\n`));
    }
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  return { body: Buffer.concat(parts), boundary };
}

// LoadImage reads by filename from input/. Anything already under input/ is
// used as-is; anything under output/ (a hand-run Qwen cleanup, a rendered
// frame) is copied into input/ first, because LoadImage takes no input link
// and nothing could order a copy step before it inside one graph.
async function uploadBufferToInput(buf, stagedRelPath) {
  const relParts = stagedRelPath.split('/');
  const stagedFilename = relParts.pop();
  const stagedSubfolder = relParts.join('/');
  const { body, boundary } = buildMultipart({
    type: 'input', subfolder: stagedSubfolder, overwrite: 'true',
    image: { data: buf, filename: stagedFilename, contentType: 'image/png' }
  });
  const upRes = await axios.post(comfyUrl + '/upload/image', body, {
    headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` }
  });
  if (upRes.status < 200 || upRes.status >= 300) {
    throw new Error('Staging into input/ failed: ' + JSON.stringify(upRes.data).slice(0, 300));
  }
  return stagedRelPath;
}

// A rendered image ComfyUI already holds, read back through its own /view.
/**
 * Refuse anything that is not actually an image.
 *
 * Both staging paths used to trust the response body. A storage or /view error
 * comes back as a small JSON payload with a 200, so the bytes were written out
 * as a .png and the run died inside ComfyUI with an unhelpful decode error
 * pointing at a staged temp file. Checking the magic bytes here names the
 * reference that failed instead.
 */
function assertImage(buf, what) {
  const png = buf.length > 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;
  const jpg = buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
  const webp = buf.length > 12 && buf.slice(0, 4).toString('latin1') === 'RIFF' &&
    buf.slice(8, 12).toString('latin1') === 'WEBP';
  if (png || jpg || webp) return buf;
  let detail = buf.length + ' bytes';
  const head = buf.slice(0, 300).toString('utf8');
  if (/^\s*[{[]/.test(head)) detail = 'the server returned an error instead: ' + head.slice(0, 200);
  throw new Error('"' + what + '" did not come back as an image (' + detail + ')');
}

async function stageFromOutput(outputRelPath, stagedRelPath) {
  const rel = outputRelPath.replace(/\\/g, '/').replace(/^output\//, '');
  const filename = rel.split('/').pop();
  const subfolder = rel.split('/').slice(0, -1).join('/');
  const readRes = await axios.get(comfyUrl + '/view', {
    params: { filename, subfolder, type: 'output' },
    responseType: 'arraybuffer'
  });
  return uploadBufferToInput(assertImage(Buffer.from(readRes.data), outputRelPath), stagedRelPath);
}

// An image the user uploaded to the movie's bucket - the reference pool. The
// previous Ref to Video flow never handled these at all, so pool images could
// be picked in the UI and were then silently ignored at render time.
async function stageFromStorage(storageKey, stagedRelPath) {
  // The key MUST be fully percent-encoded, slashes included. It is a filename
  // chosen by whoever uploaded it, so it can contain %, [, ] and spaces - and
  // an unencoded "[55%]" is not a decodable URL component. InsForge answered
  // that with a JSON error body, which this then wrote to disk as a .png; the
  // failure only surfaced much later as PIL's "cannot identify image file".
  const url =
    `${insforgeUrl}/api/storage/buckets/${movie.bucket_name}/objects/` +
    encodeURIComponent(storageKey);
  const readRes = await axios.get(url, { headers: authHeaders, responseType: 'arraybuffer' });
  return uploadBufferToInput(assertImage(Buffer.from(readRes.data), storageKey), stagedRelPath);
}

let refRelPaths;
try {
  refRelPaths = [];
  for (let i = 0; i < refs.length; i++) {
    const p = String(refs[i]).replace(/\\/g, '/');
    const ext = (p.split('.').pop() || 'png').toLowerCase().replace(/[^a-z0-9]/g, '') || 'png';
    const staged = movie.slug + '/_minimax_ref/staged/' + clipId + '_' + i + '.' + ext;
    if (/^input\//.test(p)) {
      // Character references already live under input/ and are used as-is.
      refRelPaths.push(p.replace(/^input\//, ''));
    } else if (/^output\//.test(p)) {
      refRelPaths.push(await stageFromOutput(p, staged));
    } else {
      // Anything else is a storage key from the movie's bucket.
      refRelPaths.push(await stageFromStorage(p, staged));
    }
  }
} catch (e) {
  const msg = 'Could not stage a reference image: ' + (e && e.message ? e.message : String(e));
  await updateClip({ status: 'failed', error_message: msg });
  return { action: 'error', reason: msg };
}
// The template tops out at 9 reference slots.
if (refRelPaths.length > 9) refRelPaths.length = 9;

const rawLen = Math.max(5, Math.round(clip.length || 124));
const length = Math.min(362, Math.max(124, rawLen + ((5 - (rawLen % 17)) % 17) + (rawLen % 17 > 5 ? 17 : 0)));
const width = clip.width || 864;
const height = clip.height || 480;

// Node-for-node the official R2V template, unchanged from the flow this
// replaces: res_multistep, simple, 20 steps, no SigmaShift, ref_image_size
// "match", plain LoadImage for references, CreateVideo + SaveVideo for output.
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
  '92': { class_type: 'SaveVideo', inputs: { video: ['130', 0], filename_prefix: movie.slug + '/_minimax_ref/clip_' + clipId, format: 'auto', codec: 'auto' } }
};

const refImageInputs = {};
refRelPaths.forEach((relPath, i) => {
  const nodeId = 'ref_' + i;
  g[nodeId] = { class_type: 'LoadImage', inputs: { image: relPath } };
  // ref_images is COMFY_AUTOGROW_V3: its slots are addressed by flat dotted
  // keys. A nested object is read as a plain value and the link is never made.
  refImageInputs['ref_images.ref_image_' + i] = [nodeId, 0];
});

g['136'] = {
  class_type: 'MiniMaxH3ReferenceToVideo',
  inputs: {
    clip: ['128', 0], vae: ['119', 0], audio_vae: ['120', 0],
    prompt: clip.prompt, width, height, length,
    ref_image_size: 'match',
    ...refImageInputs
  }
};

// ComfyUI answers an invalid graph with 400, and axios THROWS on non-2xx. Left
// unwrapped that aborts the whole flow, so the row stays on 'rendering' with no
// error and nothing to debug from. Capture the body instead - it names the node
// and the field it rejected.
let r;
try {
  r = await axios.post(comfyUrl + '/prompt', { prompt: g });
} catch (e) {
  const body = (e && e.response && e.response.data) || (e && e.message) || String(e);
  const msg = 'ComfyUI rejected the graph: ' + JSON.stringify(body).slice(0, 1500);
  await updateClip({ status: 'failed', error_message: msg });
  return { action: 'error', reason: msg };
}
const pid = r && r.data && r.data.prompt_id;
if (!pid) {
  const msg = 'Enqueue failed: ' + JSON.stringify((r && r.data && r.data.node_errors) || (r && r.data)).slice(0, 1500);
  await updateClip({ status: 'failed', error_message: msg });
  return { action: 'error', reason: msg };
}

const waitFor = async (promptId, maxTries, everyMs) => {
  for (let k = 0; k < maxTries; k++) {
    await sleep(everyMs);
    try {
      const h = await axios.get(comfyUrl + '/history/' + promptId);
      const rec = h && h.data && h.data[promptId];
      if (rec && rec.status && rec.status.status_str) return rec;
    } catch (e) {}
  }
  return null;
};

const rec = await waitFor(pid, 200, 5000);
if (!rec) return { action: 'pending', reason: 'Still rendering past the check window.', promptId: pid, clipId };
if (rec.status.status_str === 'error') {
  const msg = 'Render failed in ComfyUI: ' + JSON.stringify(rec.status.messages).slice(0, 1200);
  await updateClip({ status: 'failed', error_message: msg });
  return { action: 'error', reason: msg };
}

let outRel = null;
const outputs = rec.outputs || {};
for (const nid in outputs) {
  const o = outputs[nid];
  const item = (o.videos && o.videos[0]) || (o.gifs && o.gifs[0]) || (o.images && o.images[0]);
  if (item && item.filename) outRel = (item.subfolder ? item.subfolder + '/' : '') + item.filename;
}
if (!outRel) {
  const msg = 'Render produced no video output.';
  await updateClip({ status: 'failed', error_message: msg });
  return { action: 'error', reason: msg };
}

const videoPath = 'output/' + outRel;
await updateClip({ status: 'complete', video_path: videoPath, error_message: null });
return { action: 'complete', clipId, references: refRelPaths.length, length, videoPath, promptId: pid };
