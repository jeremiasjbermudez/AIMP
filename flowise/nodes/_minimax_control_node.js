// Control to Video: drive a shot with a depth, pose or edge video.
//
// The control video decides layout and motion frame by frame; the prompt and
// the reference images decide the look and who is in it. It is the route from
// a 3D package: a depth pass rendered in Blender over the scene's splat or
// mesh, with a camera move and characters blocked at true scale, becomes a
// photoreal clip that follows that camera exactly.
//
// Same model, same conditioning node as Reference to Video. The only addition
// is MiniMax-H3 Fun ControlNet Union (Alibaba PAI), applied through the
// ComfyUI-H3-FunControl nodes: the loader reads the pruned checkpoint from
// models/controlnet, and the apply node PATCHES THE MODEL, so it sits between
// the UNET loader and the guider/scheduler and everything else is unchanged.
// One checkpoint understands depth, pose, canny, HED and MLSD, so the control
// type is not a switch here - it is whatever the video shows.
//
// The control video must be the same length, width and height as the shot.
// VHS_LoadVideoPath resizes to the shot and caps the frame count; the panel
// picks a length the video can cover, and a shorter video fails here with the
// apply node's own message rather than rendering something unrelated.
const axios = require('axios');
const insforgeUrl = $insforgeUrl;
const insforgeApiKey = $insforgeApiKey;
const comfyUrl = $comfyUrl;
const comfyRoot = $comfyRoot;
const path = require('path');

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
if (!clip.prompt || !clip.prompt.trim()) return { error: 'This clip has no prompt.' };
if (!clip.control_video_path) return { error: 'This clip has no control video.' };

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

// ComfyUI's upload endpoint writes whatever bytes it is given under input/;
// it is how both images and the control video get there, since nothing in a
// graph can order a copy step before a loader.
async function uploadBufferToInput(buf, stagedRelPath, contentType) {
  const relParts = stagedRelPath.split('/');
  const stagedFilename = relParts.pop();
  const stagedSubfolder = relParts.join('/');
  const { body, boundary } = buildMultipart({
    type: 'input', subfolder: stagedSubfolder, overwrite: 'true',
    image: { data: buf, filename: stagedFilename, contentType: contentType || 'image/png' }
  });
  const upRes = await axios.post(comfyUrl + '/upload/image', body, {
    headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
    maxBodyLength: Infinity, maxContentLength: Infinity
  });
  if (upRes.status < 200 || upRes.status >= 300) {
    throw new Error('Staging into input/ failed: ' + JSON.stringify(upRes.data).slice(0, 300));
  }
  return stagedRelPath;
}

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

// A storage error comes back as a small JSON body with a 200; written out as
// a .mp4 it would only fail much later inside the video loader. Check the
// container signature so the failure names the file.
function assertVideo(buf, what) {
  const mp4 = buf.length > 12 && buf.slice(4, 8).toString('latin1') === 'ftyp';
  const webm = buf.length > 4 && buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3;
  const avi = buf.length > 12 && buf.slice(0, 4).toString('latin1') === 'RIFF' &&
    buf.slice(8, 12).toString('latin1') === 'AVI ';
  if (mp4 || webm || avi) return buf;
  let detail = buf.length + ' bytes';
  const head = buf.slice(0, 300).toString('utf8');
  if (/^\s*[{[]/.test(head)) detail = 'the server returned an error instead: ' + head.slice(0, 200);
  throw new Error('"' + what + '" is not an mp4, mov, webm or avi (' + detail + ')');
}

async function readStorage(storageKey) {
  const url =
    `${insforgeUrl}/api/storage/buckets/${movie.bucket_name}/objects/` +
    encodeURIComponent(storageKey);
  const readRes = await axios.get(url, { headers: authHeaders, responseType: 'arraybuffer', maxContentLength: Infinity });
  return Buffer.from(readRes.data);
}

async function readOutput(outputRelPath) {
  const rel = outputRelPath.replace(/\\/g, '/').replace(/^output\//, '');
  const filename = rel.split('/').pop();
  const subfolder = rel.split('/').slice(0, -1).join('/');
  const readRes = await axios.get(comfyUrl + '/view', {
    params: { filename, subfolder, type: 'output' },
    responseType: 'arraybuffer', maxContentLength: Infinity
  });
  return Buffer.from(readRes.data);
}

// ---------------------------------------------------------------- references
let refRelPaths;
try {
  refRelPaths = [];
  for (let i = 0; i < refs.length; i++) {
    const p = String(refs[i]).replace(/\\/g, '/');
    const ext = (p.split('.').pop() || 'png').toLowerCase().replace(/[^a-z0-9]/g, '') || 'png';
    const staged = movie.slug + '/_minimax_control/staged/' + clipId + '_' + i + '.' + ext;
    if (/^input\//.test(p)) {
      refRelPaths.push(p.replace(/^input\//, ''));
    } else if (/^output\//.test(p)) {
      refRelPaths.push(await uploadBufferToInput(assertImage(await readOutput(p), p), staged));
    } else {
      refRelPaths.push(await uploadBufferToInput(assertImage(await readStorage(p), p), staged));
    }
  }
} catch (e) {
  const msg = 'Could not stage a reference image: ' + (e && e.message ? e.message : String(e));
  await updateClip({ status: 'failed', error_message: msg });
  return { action: 'error', reason: msg };
}
if (refRelPaths.length > 9) refRelPaths.length = 9;

// ---------------------------------------------------------------- control video
let controlAbs;
try {
  const p = String(clip.control_video_path).replace(/\\/g, '/');
  const ext = (p.split('.').pop() || 'mp4').toLowerCase().replace(/[^a-z0-9]/g, '') || 'mp4';
  const staged = movie.slug + '/_minimax_control/staged/' + clipId + '_control.' + ext;
  const contentType = ext === 'webm' ? 'video/webm' : ext === 'avi' ? 'video/x-msvideo' : 'video/mp4';
  let rel;
  if (/^input\//.test(p)) {
    rel = p.replace(/^input\//, '');
  } else if (/^output\//.test(p)) {
    rel = await uploadBufferToInput(assertVideo(await readOutput(p), p), staged, contentType);
  } else {
    rel = await uploadBufferToInput(assertVideo(await readStorage(p), p), staged, contentType);
  }
  controlAbs = path.join(comfyRoot, 'input', rel);
} catch (e) {
  const msg = 'Could not stage the control video: ' + (e && e.message ? e.message : String(e));
  await updateClip({ status: 'failed', error_message: msg });
  return { action: 'error', reason: msg };
}

// H3 lengths are 5 mod 17 frames, 124..362. Rounded DOWN here, unlike the
// generating tabs: the control video has a fixed number of frames and the
// shot must not be longer than it.
const requested = Math.max(1, Math.round(clip.length || 124));
let length = requested - (((requested - 5) % 17) + 17) % 17;
if (length < 124) length = 124;
if (length > 362) length = 362;
const width = clip.width || 864;
const height = clip.height || 480;
const strength = Number.isFinite(Number(clip.control_strength)) ? Number(clip.control_strength) : 0.7;

const g = {
  '119': { class_type: 'VAELoader', inputs: { vae_name: 'minimax_h3_video_vae_fp16.safetensors' } },
  '120': { class_type: 'VAELoader', inputs: { vae_name: 'minimax_h3_audio_vae_fp32.safetensors' } },
  '127': { class_type: 'UNETLoader', inputs: { unet_name: 'minimax_h3_ref2va_pruned_int8_convrot.safetensors', weight_dtype: 'default' } },
  '128': { class_type: 'CLIPLoader', inputs: { clip_name: 'qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors', type: 'minimax', device: 'default' } },
  // The control video as a frame batch at the shot's size and rate. Output 0
  // is IMAGE; the pack's apply node wants exactly length x height x width.
  'ctrl_video': {
    class_type: 'VHS_LoadVideoPath',
    inputs: {
      video: controlAbs, force_rate: 24, custom_width: width, custom_height: height,
      frame_load_cap: length, skip_first_frames: 0, select_every_nth: 1
    }
  },
  'cn_load': { class_type: 'H3FunControlLoader', inputs: { control_net_name: 'minimax_h3_fun_controlnet_union_pruned_bf16.safetensors' } },
  // Patches the MODEL. start/end 0..1 = control for the whole schedule.
  'cn_apply': {
    class_type: 'H3FunControlApply',
    inputs: { model: ['127', 0], control_net: ['cn_load', 0], vae: ['119', 0], control_video: ['ctrl_video', 0], strength, start_percent: 0, end_percent: 1 }
  },
  // The pack's reference workflow: shift 12/3, res_multistep, simple, 28 steps.
  'shift': { class_type: 'MiniMaxH3SigmaShift', inputs: { model: ['cn_apply', 0], shift_video: 12, shift_audio: 3 } },
  '129': { class_type: 'RandomNoise', inputs: { noise_seed: Math.floor(Math.random() * 1e15) } },
  '123': { class_type: 'KSamplerSelect', inputs: { sampler_name: 'res_multistep' } },
  '124': { class_type: 'BasicScheduler', inputs: { model: ['shift', 0], scheduler: 'simple', steps: 28, denoise: 1 } },
  '126': { class_type: 'BasicGuider', inputs: { model: ['shift', 0], conditioning: ['136', 0] } },
  '125': { class_type: 'SamplerCustomAdvanced', inputs: { noise: ['129', 0], guider: ['126', 0], sampler: ['123', 0], sigmas: ['124', 0], latent_image: ['136', 1] } },
  '122': { class_type: 'VAEDecode', inputs: { samples: ['125', 0], vae: ['119', 0] } },
  '121': { class_type: 'VAEDecodeAudio', inputs: { samples: ['125', 0], vae: ['120', 0] } },
  '130': { class_type: 'CreateVideo', inputs: { images: ['122', 0], audio: ['121', 0], fps: 24, bit_depth: 8 } },
  '92': { class_type: 'SaveVideo', inputs: { video: ['130', 0], filename_prefix: movie.slug + '/_minimax_control/clip_' + clipId, format: 'auto', codec: 'auto' } }
};

const refImageInputs = {};
refRelPaths.forEach((relPath, i) => {
  const nodeId = 'ref_' + i;
  g[nodeId] = { class_type: 'LoadImage', inputs: { image: relPath } };
  // COMFY_AUTOGROW_V3 slots are addressed by flat dotted keys.
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
return { action: 'complete', clipId, references: refRelPaths.length, length, strength, videoPath, promptId: pid };
