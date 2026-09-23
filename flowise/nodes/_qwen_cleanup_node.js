const rawInput = ($flow.input || '').toString();
let parsed;
try { parsed = JSON.parse(rawInput); } catch (e) {
  return { error: 'Expected JSON input {"cleanupId": "<uuid>"}, got: ' + rawInput };
}
const cleanupId = parsed.cleanupId;
if (!cleanupId) return { error: 'Missing cleanupId in input.' };

const axios = require('axios');
const insforgeUrl = $insforgeUrl;
const insforgeApiKey = $insforgeApiKey;
const comfyUrl = $comfyUrl;
const comfyRoot = $comfyRoot;
const authHeaders = { Authorization: `Bearer ${insforgeApiKey}` };
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

const jobRes = await axios.get(`${insforgeUrl}/api/database/records/qwen_cleanups`, {
  params: { id: `eq.${cleanupId}`, select: '*' },
  headers: authHeaders
});
const job = (jobRes.data || [])[0];
if (!job) return { error: `No cleanup found with id ${cleanupId}.` };
if (!job.source_image_path) return { error: `Cleanup ${cleanupId} has no source image.` };

async function updateJob(patch) {
  await axios.patch(`${insforgeUrl}/api/database/records/qwen_cleanups`, patch, {
    params: { id: `eq.${cleanupId}` },
    headers: { ...authHeaders, 'Content-Type': 'application/json', Prefer: 'return=minimal' }
  });
}

const movieRes = await axios.get(`${insforgeUrl}/api/database/records/movies`, {
  params: { id: `eq.${job.movie_id}`, select: 'slug,bucket_name' },
  headers: authHeaders
});
const movie = (movieRes.data || [])[0];
if (!movie) return { error: `Movie ${job.movie_id} not found.` };

// Figure 2 is the clean reference the edit corrects Figure 1 against. It comes
// either from an uploaded file or from the chosen scene's existing panorama;
// without one there is nothing to fix the perspective against, so this is a
// hard requirement rather than a silent fallback to a one-image edit.
let panoComfyPath = job.reference_pano_path;
if (!job.reference_image_path && !panoComfyPath && job.act_number != null && job.scene_number != null) {
  const panoRes = await axios.get(`${insforgeUrl}/api/database/records/scene_panos`, {
    params: {
      movie_id: `eq.${job.movie_id}`,
      act_number: `eq.${job.act_number}`,
      scene_number: `eq.${job.scene_number}`,
      select: 'image_path'
    },
    headers: authHeaders
  });
  const pano = (panoRes.data || [])[0];
  if (pano) panoComfyPath = pano.image_path;
}
if (!job.reference_image_path && !panoComfyPath) {
  const msg = `Cleanup ${cleanupId} has no reference image: upload one, or pick a scene that already has a panorama.`;
  await updateJob({ status: 'failed', error_message: msg });
  return { error: msg };
}

await updateJob({ status: 'rendering', error_message: null, reference_pano_path: panoComfyPath || null });

function buildMultipart(fields) {
  const boundary = '----FlowiseQwenCleanup' + Math.random().toString(16).slice(2);
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

// Uploads live in InsForge storage; JWImageLoadRGB reads absolute paths on the
// ComfyUI box, so each one is pulled down and re-uploaded into input/ first.
//
// But not every source IS an upload. The Camera tab cleans up a rendered plate,
// whose path is a ComfyUI path ("input/<movie>/_SplatPlates/...") - asking
// storage for it returned a strategy with no url, and axios then failed with
// "url is required", which named nothing. So the kind of path decides the
// route: under input/ it is already where ComfyUI wants it, under output/ it is
// read back through /view, and anything else is a storage key as before.
async function stageAny(sourcePath, stagedRelPath) {
  const p = String(sourcePath).split(String.fromCharCode(92)).join('/');
  if (/^input\//i.test(p)) return comfyRoot + p;
  if (/^output\//i.test(p)) return stageFromOutput(p, stagedRelPath);
  return stageFromStorage(p, stagedRelPath);
}

// A picture ComfyUI already holds under output/ (a cleaned plate, a rendered
// frame). /view serves it; it is re-uploaded into input/ because JWImageLoadRGB
// is given an absolute path and input/ is what the rest of this graph uses.
async function stageFromOutput(outputRelPath, stagedRelPath) {
  const rel = outputRelPath.replace(/^output\//i, '');
  const filename = rel.split('/').pop();
  const subfolder = rel.split('/').slice(0, -1).join('/');
  const readRes = await axios.get(comfyUrl + '/view', {
    params: { filename, subfolder, type: 'output' },
    responseType: 'arraybuffer'
  });
  return uploadToInput(Buffer.from(readRes.data), stagedRelPath);
}

// The shared tail of both staging routes.
async function uploadToInput(buf, stagedRelPath) {
  const relParts = stagedRelPath.split('/');
  const stagedFilename = relParts.pop();
  const stagedSubfolder = relParts.join('/');
  const { body, boundary } = buildMultipart({
    type: 'input', subfolder: stagedSubfolder, overwrite: 'true',
    image: { data: buf, filename: stagedFilename, contentType: 'image/png' }
  });
  const upRes = await axios.post(comfyUrl + '/upload/image', body, { headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` } });
  if (upRes.status < 200 || upRes.status >= 300) {
    throw new Error('Staging image into ComfyUI input/ failed: ' + JSON.stringify(upRes.data).slice(0, 300));
  }
  return comfyRoot + 'input/' + stagedRelPath;
}

async function stageFromStorage(storageKey, stagedRelPath) {
  const key = encodeURIComponent(storageKey);
  const strategyRes = await axios.get(`${insforgeUrl}/api/storage/buckets/${movie.bucket_name}/download-strategy/objects/${key}`, { headers: authHeaders });
  const strategy = strategyRes.data;
  const fileHeaders = strategy.method === 'direct' ? authHeaders : {};
  if (!strategy || !strategy.url) {
    throw new Error(`"${storageKey}" is not a file in this movie's storage bucket (and is not a ComfyUI input/ or output/ path either).`);
  }
  const fileRes = await axios.get(strategy.url, { headers: fileHeaders, responseType: 'arraybuffer' });
  return uploadToInput(Buffer.from(fileRes.data), stagedRelPath);
}

let uglyPath;
let cleanPath;
try {
  uglyPath = await stageAny(job.source_image_path, movie.slug + '/_qwen_cleanup_src/cleanup_' + cleanupId + '_source.png');
  cleanPath = job.reference_image_path
    ? await stageAny(job.reference_image_path, movie.slug + '/_qwen_cleanup_src/cleanup_' + cleanupId + '_reference.png')
    : comfyRoot + panoComfyPath;
} catch (e) {
  const msg = 'Image staging failed: ' + (e && e.message ? e.message : String(e));
  await updateJob({ status: 'failed', error_message: msg });
  return { action: 'error', reason: msg };
}

const promptText = (job.prompt && job.prompt.trim())
  ? job.prompt
  : 'Using Gaussian Splatting, refer to the scene graph in Figure 2 to fix the perspective of the scene graph in Figure 1 and fill in the blank areas.';

// @include comfy_models

// Whichever precision of each model this ComfyUI holds, best first. The graph
// was built on the bf16 edit model and the 2512 Lightning LoRA; a render host
// with the int8 or 2509 model, or the 2511 Lightning, runs the same graph.
// Lightning is required: 10 steps at cfg 1 only works with it. Sharp and F2P
// refine the result and are left out when they are not installed.
let qwenModels;
try {
  qwenModels = {
    unet: await pickModel('diffusion_models', ['qwen_image_edit_2511_bf16.safetensors', 'qwen_image_edit_2511_int8_convrot.safetensors', 'qwen_image_edit_2509_fp8_e4m3fn.safetensors']),
    clip: await pickModel('text_encoders', ['qwen/qwen_2.5_vl_7b.safetensors', 'qwen_2.5_vl_7b_fp8_scaled.safetensors', 'qwen2.5vl-7b-bf16.safetensors']),
    vae: await pickModel('vae', ['qwen-image/qwen_image_vae.safetensors']),
    sharp: await pickModel('loras', ['Sharp.safetensors'], { optional: true }),
    lightning: await pickModel('loras', ['Qwen-Image-2512-Lightning-4steps-V1.0-fp32.safetensors', 'Qwen-Image-Edit-2511-Lightning-4steps-V1.0-bf16.safetensors', 'Qwen-Image-Edit-2509-Lightning-4steps-V1.0-bf16.safetensors']),
    f2p: await pickModel('loras', ['Qwen-Image-Edit-F2P.safetensors'], { optional: true })
  };
} catch (e) {
  await updateJob({ status: 'failed', error_message: e.message });
  return { action: 'error', reason: e.message };
}

// Same graph 6-GS-Cleaner runs, lifted node-for-node so the standalone tab and
// the shot pipeline can't produce different results from the same inputs.
const g = {
  '1': { class_type: 'UNETLoader', inputs: { unet_name: qwenModels.unet, weight_dtype: 'default' } },
  '2': { class_type: 'CLIPLoader', inputs: { clip_name: qwenModels.clip, type: 'qwen_image', device: 'default' } },
  '3': { class_type: 'VAELoader', inputs: { vae_name: qwenModels.vae } },
  '7': { class_type: 'ModelSamplingAuraFlow', inputs: { model: ['1', 0], shift: 3 } },
  '8': { class_type: 'CFGNorm', inputs: { model: ['7', 0], strength: 1, pre_cfg: false } },
  '9': { class_type: 'JWImageLoadRGB', inputs: { path: uglyPath } },
  '10': { class_type: 'JWImageLoadRGB', inputs: { path: cleanPath } },
  '11': { class_type: 'ImageScaleToTotalPixels', inputs: { image: ['9', 0], upscale_method: 'nearest-exact', megapixels: 1, resolution_steps: 1 } },
  '12': { class_type: 'ImageScaleToTotalPixels', inputs: { image: ['10', 0], upscale_method: 'lanczos', megapixels: 1, resolution_steps: 1 } },
  '13': { class_type: 'TextEncodeQwenImageEditPlus', inputs: { clip: ['2', 0], vae: ['3', 0], image1: ['11', 0], image2: ['12', 0], prompt: promptText } },
  '14': { class_type: 'TextEncodeQwenImageEditPlus', inputs: { clip: ['2', 0], vae: ['3', 0], image1: ['11', 0], image2: ['12', 0], prompt: '' } },
  '15': { class_type: 'FluxKontextMultiReferenceLatentMethod', inputs: { conditioning: ['13', 0], reference_latents_method: 'index_timestep_zero' } },
  '16': { class_type: 'FluxKontextMultiReferenceLatentMethod', inputs: { conditioning: ['14', 0], reference_latents_method: 'index_timestep_zero' } },
  '17': { class_type: 'VAEEncode', inputs: { pixels: ['11', 0], vae: ['3', 0] } },
  '18': { class_type: 'KSampler', inputs: { model: ['8', 0], positive: ['15', 0], negative: ['16', 0], latent_image: ['17', 0], seed: Math.floor(Math.random() * 1e15), steps: 10, cfg: 1, sampler_name: 'euler', scheduler: 'simple', denoise: 1 } },
  '19': { class_type: 'VAEDecode', inputs: { samples: ['18', 0], vae: ['3', 0] } },
  '20': { class_type: 'SaveImage', inputs: { images: ['19', 0], filename_prefix: movie.slug + '/_qwen_splat_cleanup/standalone_' + cleanupId } }
};

// The LoRA chain, Sharp -> Lightning -> F2P, of whichever are installed.
{
  let modelRef = ['1', 0];
  [['4', qwenModels.sharp, 1], ['5', qwenModels.lightning, 1], ['6', qwenModels.f2p, 0.65]].forEach(([id, name, strength]) => {
    if (!name) return;
    g[id] = { class_type: 'LoraLoaderModelOnly', inputs: { model: modelRef, lora_name: name, strength_model: strength } };
    modelRef = [id, 0];
  });
  g['7'].inputs.model = modelRef;
}

const r = await axios.post(comfyUrl + '/prompt', { prompt: g });
const pid = r && r.data && r.data.prompt_id;
if (!pid) {
  const msg = 'Qwen cleanup enqueue failed: ' + JSON.stringify((r && r.data && r.data.node_errors) || (r && r.data)).slice(0, 1000);
  await updateJob({ status: 'failed', error_message: msg });
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

const rec = await waitFor(pid, 150, 5000);
if (!rec) {
  return { action: 'pending', reason: 'Qwen cleanup still running past the check window.', promptId: pid, cleanupId };
}
if (rec.status.status_str === 'error') {
  const msg = 'Qwen cleanup failed in ComfyUI: ' + JSON.stringify(rec.status.messages).slice(0, 1000);
  await updateJob({ status: 'failed', error_message: msg });
  return { action: 'error', reason: msg };
}

let outRel = null;
const outputs = rec.outputs || {};
for (const nid in outputs) {
  if (outputs[nid].images && outputs[nid].images[0]) {
    const f = outputs[nid].images[0];
    outRel = (f.subfolder ? f.subfolder + '/' : '') + f.filename;
  }
}
if (!outRel) {
  const msg = 'Qwen cleanup produced no output image.';
  await updateJob({ status: 'failed', error_message: msg });
  return { action: 'error', reason: msg };
}

const cleanedImagePath = 'output/' + outRel;
await updateJob({ status: 'complete', cleaned_image_path: cleanedImagePath, error_message: null });
return { action: 'complete', cleanupId, cleanedImagePath, promptId: pid };
