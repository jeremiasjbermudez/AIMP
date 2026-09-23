const resolved = JSON.parse($resolveOutput);
if (resolved.error) return { error: resolved.error };

const { shotId, bucketName, movieSlug, rawCapturePath, panoImagePath } = resolved;

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

function buildMultipart(fields) {
  const boundary = '----FlowiseShotUpload' + Math.random().toString(16).slice(2);
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

const key = encodeURIComponent(rawCapturePath);
const strategyRes = await axios.get(`${insforgeUrl}/api/storage/buckets/${bucketName}/download-strategy/objects/${key}`, {
  headers: authHeaders
});
const strategy = strategyRes.data;
const fileHeaders = strategy.method === 'direct' ? authHeaders : {};
const fileRes = await axios.get(strategy.url, { headers: fileHeaders, responseType: 'arraybuffer' });
const rawBuf = Buffer.from(fileRes.data);

const stagedFilename = 'shot_' + shotId + '_raw.png';
const stagedSubfolder = movieSlug + '/_shots_raw';
const { body, boundary } = buildMultipart({
  type: 'input',
  subfolder: stagedSubfolder,
  overwrite: 'true',
  image: { data: rawBuf, filename: stagedFilename, contentType: 'image/png' }
});
const upRes = await axios.post(comfyUrl + '/upload/image', body, { headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` } });
if (upRes.status < 200 || upRes.status >= 300) {
  await updateShot({ status: 'failed', error_message: 'Raw capture upload to ComfyUI failed: ' + JSON.stringify(upRes.data).slice(0, 300) });
  return { action: 'error', reason: 'Raw capture upload to ComfyUI failed.' };
}
const uglyPath = String($comfyRoot || 'C:/ComfyUI2').replace(/[\\/]+$/, '') + '/input/' + stagedSubfolder + '/' + stagedFilename;
const cleanPath = String($comfyRoot || 'C:/ComfyUI2').replace(/[\\/]+$/, '') + '/' + panoImagePath;
const tag = 'shot_' + shotId;

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
  return { action: 'error', reason: e.message };
}

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
  '13': { class_type: 'TextEncodeQwenImageEditPlus', inputs: {
    clip: ['2', 0], vae: ['3', 0], image1: ['11', 0], image2: ['12', 0],
    prompt: 'Using Gaussian Splatting, refer to the scene graph in Figure 2 to fix the perspective of the scene graph in Figure 1 and fill in the blank areas.'
  }},
  '14': { class_type: 'TextEncodeQwenImageEditPlus', inputs: {
    clip: ['2', 0], vae: ['3', 0], image1: ['11', 0], image2: ['12', 0], prompt: ''
  }},
  '15': { class_type: 'FluxKontextMultiReferenceLatentMethod', inputs: { conditioning: ['13', 0], reference_latents_method: 'index_timestep_zero' } },
  '16': { class_type: 'FluxKontextMultiReferenceLatentMethod', inputs: { conditioning: ['14', 0], reference_latents_method: 'index_timestep_zero' } },
  '17': { class_type: 'VAEEncode', inputs: { pixels: ['11', 0], vae: ['3', 0] } },
  '18': { class_type: 'KSampler', inputs: {
    model: ['8', 0], positive: ['15', 0], negative: ['16', 0], latent_image: ['17', 0],
    seed: Math.floor(Math.random() * 1e15), steps: 10, cfg: 1, sampler_name: 'euler', scheduler: 'simple', denoise: 1
  }},
  '19': { class_type: 'VAEDecode', inputs: { samples: ['18', 0], vae: ['3', 0] } },
  '20': { class_type: 'SaveImage', inputs: { images: ['19', 0], filename_prefix: movieSlug + '/_qwen_splat_cleanup/' + tag } }
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
  await updateShot({ status: 'failed', error_message: msg });
  return { action: 'error', reason: msg };
}

const rec = await waitFor(pid, 150, 5000);
if (!rec) {
  return { action: 'pending', reason: 'Qwen cleanup still running past the check window.', promptId: pid };
}
if (rec.status.status_str === 'error') {
  const msg = 'Qwen cleanup failed in ComfyUI: ' + JSON.stringify(rec.status.messages).slice(0, 1000);
  await updateShot({ status: 'failed', error_message: msg });
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
  await updateShot({ status: 'failed', error_message: msg });
  return { action: 'error', reason: msg };
}

const cleanedImagePath = 'output/' + outRel;
await updateShot({ status: 'cleaned', cleaned_image_path: cleanedImagePath, error_message: null });

return { action: 'cleaned', shotId, cleanedImagePath, promptId: pid };
