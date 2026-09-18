// Z-Image Turbo: generation only, with LoRAs.
//
// Deliberately NOT an editor. Z-Image's reference-image path runs through
// TextEncodeZImageOmni's image1..3 slots, and those need the Omni checkpoint,
// which Tongyi has not released - the Turbo weights concatenate the reference
// latents into a sequence they cannot consume, and the sampler dies on a shape
// mismatch. Tested: it fails identically whether the empty latent matches the
// reference or not. So the images are simply never wired, and the tab hides the
// reference picker for this engine rather than offering something that breaks.
//
// When Z-Image-Edit ships (Apache-2.0, unlike everything else in this space)
// the nodes are already registered here - it becomes a weights download and
// three more links, not an integration.
//
// 8 steps at cfg 1: Turbo is distilled, and guidance on a distilled model
// scorches the image rather than sharpening it.
const axios = require('axios');

const insforgeUrl = $insforgeUrl;
const insforgeApiKey = $insforgeApiKey;
const comfyUrl = $comfyUrl;
const authHeaders = { Authorization: `Bearer ${insforgeApiKey}` };

let parsed;
try {
  parsed = JSON.parse(($flow.input || '').toString());
} catch (e) {
  return { error: 'Expected JSON {"movieId":"...","prompt":"..."}' };
}

const prompt = (parsed.prompt || '').toString().trim();
if (!prompt) return { error: 'Describe the image you want.' };
if (!parsed.movieId) return { error: 'Missing movieId.' };

const movieRes = await axios.get(`${insforgeUrl}/api/database/records/movies`, {
  params: { id: `eq.${parsed.movieId}`, select: 'id,slug' },
  headers: authHeaders
});
const movie = (movieRes.data || [])[0];
if (!movie) return { error: 'Movie not found.' };

// Z-Image's latent is /8 and patchified by 2, so both edges must be a multiple
// of 16 or the sampler reshape fails.
function snap16(v, fallback) {
  const n = Math.round(Number(v) || fallback);
  return Math.max(256, Math.round(n / 16) * 16);
}
const width = snap16(parsed.width, 1024);
const height = snap16(parsed.height, 1024);
const steps = Math.max(1, Number(parsed.steps) || 8);
const seed = Math.floor(Math.random() * 2147483647);

const loras = Array.isArray(parsed.loras) ? parsed.loras.filter((l) => l && l.name) : [];

const outPrefix = movie.slug + '/_ZImage/gen';

const g = {
  '1': { class_type: 'UNETLoader', inputs: { unet_name: 'z_image_turbo_bf16.safetensors', weight_dtype: 'default' } },
  '2': { class_type: 'CLIPLoader', inputs: { clip_name: 'qwen_3_4b.safetensors', type: 'qwen_image', device: 'default' } },
  '3': { class_type: 'VAELoader', inputs: { vae_name: 'ae.safetensors' } },
  '7': { class_type: 'EmptySD3LatentImage', inputs: { width: width, height: height, batch_size: 1 } },
  '9': { class_type: 'VAEDecode', inputs: { samples: ['8', 0], vae: ['3', 0] } },
  '10': { class_type: 'SaveImage', inputs: { images: ['9', 0], filename_prefix: outPrefix } }
};

// LoRAs chain off the loaders, each onto whatever the current tip is, so
// several stack in the order they were picked.
let modelRef = ['1', 0];
let clipRef = ['2', 0];
loras.forEach((l, i) => {
  const id = 'lora_' + i;
  g[id] = {
    class_type: 'LoraLoader',
    inputs: {
      model: modelRef,
      clip: clipRef,
      lora_name: l.name,
      strength_model: Number(l.strength) || 1,
      // The CLIP side follows the model strength here rather than being pinned
      // low: these are style LoRAs, not identity ones.
      strength_clip: Number(l.strength) || 1
    }
  };
  modelRef = [id, 0];
  clipRef = [id, 1];
});

// Prompt only. image1..3 exist on this node and are left unconnected on
// purpose - see the note at the top.
g['5'] = {
  class_type: 'TextEncodeZImageOmni',
  inputs: { clip: clipRef, prompt: prompt, auto_resize_images: true }
};
g['6'] = { class_type: 'ConditioningZeroOut', inputs: { conditioning: ['5', 0] } };
g['8'] = {
  class_type: 'KSampler',
  inputs: {
    seed: seed,
    steps: steps,
    cfg: 1,
    sampler_name: 'euler',
    scheduler: 'simple',
    denoise: 1,
    model: modelRef,
    positive: ['5', 0],
    negative: ['6', 0],
    latent_image: ['7', 0]
  }
};

let q;
try {
  q = await axios.post(`${comfyUrl}/prompt`, { prompt: g });
} catch (e) {
  const body = (e && e.response && e.response.data) || (e && e.message) || String(e);
  return { action: 'error', reason: 'ComfyUI rejected the graph: ' + JSON.stringify(body).slice(0, 1200) };
}
const promptId = q.data && q.data.prompt_id;
if (!promptId) {
  return { action: 'error', reason: 'Enqueue failed: ' + JSON.stringify(q.data).slice(0, 800) };
}

let outRel = null;
for (let i = 0; i < 120; i++) {
  await new Promise((r) => setTimeout(r, 3000));
  const h = await axios.get(`${comfyUrl}/history/${promptId}`);
  const entry = h.data && h.data[promptId];
  if (!entry) continue;
  const st = entry.status || {};
  if (st.status_str === 'error') {
    return { action: 'error', reason: 'ComfyUI failed: ' + JSON.stringify(st.messages || '').slice(-600) };
  }
  const outs = entry.outputs || {};
  for (const k of Object.keys(outs)) {
    const imgs = outs[k].images || [];
    if (imgs.length) {
      outRel = (imgs[0].subfolder ? imgs[0].subfolder + '/' : '') + imgs[0].filename;
      break;
    }
  }
  if (outRel) break;
}
if (!outRel) return { action: 'error', reason: 'Timed out waiting for the image.' };

const imagePath = 'output/' + outRel;
const ins = await axios.post(
  `${insforgeUrl}/api/database/records/image_edits`,
  [
    {
      movie_id: movie.id,
      prompt: prompt,
      reference_paths: [],
      reference_labels: [],
      output_path: imagePath,
      width: width,
      height: height,
      steps: steps,
      seed: seed,
      engine: 'zimage',
      loras: loras,
      status: 'complete'
    }
  ],
  { headers: authHeaders }
);

return {
  action: 'complete',
  editId: (ins.data && ins.data[0] && ins.data[0].id) || null,
  outputPath: imagePath,
  width: width,
  height: height,
  steps: steps,
  seed: seed,
  loras: loras.map((l) => l.name)
};
