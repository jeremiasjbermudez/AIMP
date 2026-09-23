// Qwen Image Edit: the same idea as the FLUX.2 Klein tab - a prompt plus a few
// reference images - rendered by Qwen-Rapid-AIO instead.
//
// Kept as its own flow rather than a branch inside the Klein one because the
// two graphs share nothing but the staging and polling: different loader,
// different conditioning, different sampler settings, different reference
// limit. Results land in the same image_edits table, tagged with engine.
const axios = require('axios');
const fs = require('fs');
const path = require('path');

const insforgeUrl = $insforgeUrl;
const insforgeApiKey = $insforgeApiKey;
const comfyUrl = $comfyUrl;
const authHeaders = { Authorization: `Bearer ${insforgeApiKey}` };

const COMFY_ROOT = String($comfyRoot || 'C:/ComfyUI2').replace(/[\\/]+$/, '');
const COMFY_INPUT = COMFY_ROOT + '/input';

let parsed;
try {
  parsed = JSON.parse(($flow.input || '').toString());
} catch (e) {
  return { error: 'Expected JSON input {"movieId":"...","prompt":"...","references":[...]}' };
}

const movieId = parsed.movieId;
const prompt = (parsed.prompt || '').toString().trim();
if (!movieId) return { error: 'Missing movieId.' };
if (!prompt) return { error: 'Describe the edit you want.' };

const movieRes = await axios.get(`${insforgeUrl}/api/database/records/movies`, {
  params: { id: `eq.${movieId}`, select: 'id,slug,bucket_name' },
  headers: authHeaders
});
const movie = (movieRes.data || [])[0];
if (!movie) return { error: 'Movie not found.' };

// A reference is either a ComfyUI path already ({path}) or something in
// InsForge storage ({storageKey}) that has to be staged into ComfyUI's input
// folder before LoadImage can read it.
// Zero references is a legitimate mode: with no image on the encoder the graph
// is a plain text-to-image, which is exactly what you want when there is
// nothing to carry across from an existing picture.
const incoming = Array.isArray(parsed.references) ? parsed.references : [];
// Hard limit, not a policy: TextEncodeQwenImageEditPlus exposes image1,
// image2 and image3 and nothing further.
if (incoming.length > 3) return { error: 'Qwen Image Edit takes at most three reference images.' };

fs.mkdirSync(COMFY_INPUT, { recursive: true });
const staged = [];
for (const ref of incoming) {
  if (ref && ref.path) {
    // Stored paths carry mixed separators, and they point at either ComfyUI's
    // input/ or its output/ folder. LoadImage only ever reads from input/, so
    // anything generated - QA shots, earlier edits, renders - has to be copied
    // in first. Before this, an output/ reference produced a job that could not
    // load its own image, and the row was left stranded at "rendering".
    const norm = String(ref.path).split(String.fromCharCode(92)).join('/');
    const isInput = /^input\//i.test(norm);
    const rel = isInput ? norm.replace(/^input\//i, '') : norm;
    const full = path.join(COMFY_ROOT, isInput ? 'input' : '', ...rel.split('/').filter(Boolean));
    if (!fs.existsSync(full)) {
      return { error: 'Reference image is missing on disk: ' + ref.path };
    }
    if (isInput) {
      staged.push({ load: rel, label: ref.label || rel.split('/').pop(), source: ref.path });
    } else {
      const dir = path.join(COMFY_INPUT, '_edit_sources');
      fs.mkdirSync(dir, { recursive: true });
      const base = 'ref_' + norm.replace(/[^A-Za-z0-9._-]/g, '_').slice(-70);
      fs.copyFileSync(full, path.join(dir, base));
      staged.push({ load: '_edit_sources/' + base, label: ref.label || norm.split('/').pop(), source: ref.path });
    }
  } else if (ref && ref.storageKey) {
    const strategyRes = await axios.get(
      `${insforgeUrl}/api/storage/buckets/${movie.bucket_name}/download-strategy/objects/${encodeURIComponent(ref.storageKey)}`,
      { headers: authHeaders }
    );
    const strategy = strategyRes.data;
    const fileRes = await axios.get(strategy.url, {
      headers: strategy.method === 'direct' ? authHeaders : {},
      responseType: 'arraybuffer'
    });
    const dir = path.join(COMFY_INPUT, '_edit_sources');
    fs.mkdirSync(dir, { recursive: true });
    const base = 'edit_' + String(ref.storageKey).replace(/[^A-Za-z0-9._-]/g, '_').slice(-60);
    fs.writeFileSync(path.join(dir, base), Buffer.from(fileRes.data));
    staged.push({ load: '_edit_sources/' + base, label: ref.label || base, source: ref.storageKey });
  } else {
    return { error: 'Each reference needs either a path or a storageKey.' };
  }
}

const W = Math.max(256, Math.min(2048, Number(parsed.width) || 1080));
const H = Math.max(256, Math.min(2048, Number(parsed.height) || 1080));
const steps = Math.max(1, Math.min(40, Number(parsed.steps) || 4));
const seed = Number(parsed.seed) || Math.floor(Math.random() * 1e9);

// LoRAs, in the order the UI listed them. Order matters: LoraLoaders are
// chained, so the second one sees a model the first has already changed.
//
// `loras` is the current shape. `useHighDetail` / `highDetailStrength` are the
// older single-LoRA inputs and are still honoured, so an older caller - or a
// saved row being re-run - keeps working.
const DEFAULT_LORA = 'HighDetail.safetensors';
function readLoras() {
  if (Array.isArray(parsed.loras)) {
    return parsed.loras
      .map((l) => ({
        name: String((l && l.name) || '').trim(),
        // 0 is a legitimate request to disable one without removing it, so the
        // floor is 0 rather than a fallback to the default.
        strength: Math.max(0, Math.min(2, Number(l && l.strength != null ? l.strength : 1)))
      }))
      .filter((l) => l.name)
      .slice(0, 8);
  }
  // Nothing asked for means no LoRA. It used to mean HighDetail at 0.4, which
  // silently altered every edit whether or not it suited the references.
  if (parsed.useHighDetail !== true) return [];
  return [{
    name: DEFAULT_LORA,
    strength: Math.max(0, Math.min(2, Number(parsed.highDetailStrength != null ? parsed.highDetailStrength : 0.4)))
  }];
}
const loras = readLoras();

const rowRes = await axios.post(
  `${insforgeUrl}/api/database/records/image_edits`,
  [
    {
      movie_id: movieId,
      prompt: prompt,
      reference_paths: staged.map((s) => s.source),
      reference_labels: staged.map((s) => s.label),
      width: W,
      height: H,
      steps: steps,
      seed: seed,
      lora_name: loras.length ? loras[0].name : null,
      lora_strength: loras.length ? loras[0].strength : null,
      loras: loras,
      engine: 'qwen',
      status: 'rendering'
    }
  ],
  { headers: { ...authHeaders, 'Content-Type': 'application/json', Prefer: 'return=representation' } }
);
const row = (rowRes.data || [])[0];

async function fail(message) {
  if (row) {
    await axios.patch(
      `${insforgeUrl}/api/database/records/image_edits?id=eq.${row.id}`,
      { status: 'failed', error_message: String(message).slice(0, 800) },
      { headers: { ...authHeaders, 'Content-Type': 'application/json' } }
    );
  }
  return { action: 'error', reason: message, editId: row && row.id };
}

// The graph, node for node as saved in ComfyUI (AIG-AIO, workflow
// b058853e-412f-4f02-95e2-abe2a40ebc2e).
//
// Qwen carries its references quite differently from Klein: instead of a chain
// of ReferenceLatents, the images are handed straight to the text encoder as
// image1/image2/image3, so the encoder sees the prompt and the pictures
// together. That is also why three is a hard ceiling here - those are the only
// image inputs the node has.
const CHECKPOINT = 'Qwen-Rapid-AIO-NSFW-v23.safetensors';
// Under the movie's own folder, which is where the rest of the pipeline puts
// its output - _pano, _minimax_ref, _scores, _qwen_splat_cleanup are all
// output/<slug>/<category>. Keeping to that means one project is one folder.
const outPrefix = `${movie.slug}/_QwenEdits/edit`;

// @include comfy_models

// The all-in-one checkpoint when this ComfyUI has it. Otherwise the same model
// from its parts - the Qwen edit weights, text encoder and VAE, with the
// Lightning LoRA that the checkpoint has merged in - so a render host without
// it can still run this engine. Its sampler settings are tuned to the
// checkpoint; the parts run with Lightning's own (euler / simple).
const wf = {};
let modelRef;
let clipRef;
let vaeRef;
let aio;
try {
  aio = await pickModel('checkpoints', [CHECKPOINT], { optional: true });
  if (aio) {
    wf['1'] = { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: aio } };
    modelRef = ['1', 0];
    clipRef = ['1', 1];
    vaeRef = ['1', 2];
  } else {
    wf['1'] = { class_type: 'UNETLoader', inputs: { unet_name: await pickModel('diffusion_models', ['qwen_image_edit_2511_bf16.safetensors', 'qwen_image_edit_2511_int8_convrot.safetensors', 'qwen_image_edit_2509_fp8_e4m3fn.safetensors']), weight_dtype: 'default' } };
    wf['11'] = { class_type: 'CLIPLoader', inputs: { clip_name: await pickModel('text_encoders', ['qwen/qwen_2.5_vl_7b.safetensors', 'qwen_2.5_vl_7b_fp8_scaled.safetensors', 'qwen2.5vl-7b-bf16.safetensors']), type: 'qwen_image', device: 'default' } };
    wf['12'] = { class_type: 'VAELoader', inputs: { vae_name: await pickModel('vae', ['qwen-image/qwen_image_vae.safetensors']) } };
    wf['13'] = { class_type: 'LoraLoaderModelOnly', inputs: { model: ['1', 0], lora_name: await pickModel('loras', ['Qwen-Image-Edit-2511-Lightning-4steps-V1.0-bf16.safetensors', 'Qwen-Image-2512-Lightning-4steps-V1.0-fp32.safetensors', 'Qwen-Image-Edit-2509-Lightning-4steps-V1.0-bf16.safetensors']), strength_model: 1 } };
    wf['14'] = { class_type: 'ModelSamplingAuraFlow', inputs: { model: ['13', 0], shift: 3 } };
    modelRef = ['14', 0];
    clipRef = ['11', 0];
    vaeRef = ['12', 0];
  }
} catch (e) {
  return await fail(e.message);
}

// LoraLoaderModelOnly, chained. Qwen's LoRAs apply to the model only - the
// text encoder is not patched - so unlike the Klein graph there is no clip to
// thread through.
loras.forEach((l, i) => {
  const id = String(40 + i);
  wf[id] = {
    class_type: 'LoraLoaderModelOnly',
    inputs: { model: modelRef, lora_name: l.name, strength_model: l.strength }
  };
  modelRef = [id, 0];
});

// The references land on the positive encoder as image1..image3.
const positive = { clip: clipRef, vae: vaeRef, prompt: prompt.slice(0, 1800) };
staged.forEach((s, i) => {
  const id = String(70 + i);
  wf[id] = { class_type: 'LoadImage', inputs: { image: s.load } };
  positive['image' + (i + 1)] = [id, 0];
});

Object.assign(wf, {
  '3': { class_type: 'TextEncodeQwenImageEditPlus', inputs: positive },
  // Deliberately empty, as in the saved workflow - this checkpoint is tuned to
  // run with no negative prompt at cfg 1.
  '4': { class_type: 'TextEncodeQwenImageEditPlus', inputs: { clip: clipRef, vae: vaeRef, prompt: '' } },
  '9': { class_type: 'EmptyLatentImage', inputs: { width: W, height: H, batch_size: 1 } },
  '2': {
    class_type: 'KSampler',
    inputs: {
      seed: seed,
      steps: steps,
      cfg: 1,
      sampler_name: aio ? 'sa_solver' : 'euler',
      scheduler: aio ? 'beta' : 'simple',
      denoise: 1,
      model: modelRef,
      positive: ['3', 0],
      negative: ['4', 0],
      latent_image: ['9', 0]
    }
  },
  '5': { class_type: 'VAEDecode', inputs: { samples: ['2', 0], vae: vaeRef } },
  // PreviewImage in the saved workflow, which writes to temp and is swept up.
  // The result has to outlive the run to be shown and reused, so it is saved.
  '6': { class_type: 'SaveImage', inputs: { images: ['5', 0], filename_prefix: outPrefix } }
});

let promptId;
try {
  const q = await axios.post(`${comfyUrl}/prompt`, { prompt: wf });
  promptId = q.data.prompt_id;
} catch (e) {
  const detail = e.response ? JSON.stringify(e.response.data).slice(0, 500) : e.message;
  return await fail('ComfyUI refused the job: ' + detail);
}

let outputPath = null;
// 10 minutes. Qwen-Rapid is a 4-step checkpoint and finishes a 1080x1080 job
// in well under a minute idle, so a job still silent at ten minutes is wedged.
const MAX_POLLS = 120;
const startedAt = Date.now();
for (let i = 0; i < MAX_POLLS; i++) {
  await new Promise((r) => setTimeout(r, 5000));
  const h = await axios.get(`${comfyUrl}/history/${promptId}`);
  const entry = h.data[promptId];
  if (!entry) continue;
  const status = entry.status || {};
  if (status.status_str === 'error') {
    const msg = (status.messages || []).filter((m) => m[0] === 'execution_error');
    return await fail(JSON.stringify(msg).slice(0, 500));
  }
  for (const out of Object.values(entry.outputs || {})) {
    for (const im of out.images || []) {
      outputPath = 'output/' + (im.subfolder ? im.subfolder + '/' : '') + im.filename;
      break;
    }
    if (outputPath) break;
  }
  if (outputPath) break;
  if (status.completed) return await fail('Finished with no image.');
}
if (!outputPath) {
  return await fail(
    'Timed out after ' + Math.round((Date.now() - startedAt) / 1000) +
      's waiting for ComfyUI. The job was accepted but produced nothing - check the ComfyUI console.'
  );
}

if (row) {
  await axios.patch(
    `${insforgeUrl}/api/database/records/image_edits?id=eq.${row.id}`,
    { status: 'complete', output_path: outputPath },
    { headers: { ...authHeaders, 'Content-Type': 'application/json' } }
  );
}

return {
  action: 'complete',
  editId: row && row.id,
  outputPath: outputPath,
  seed: seed,
  lora: loras.length ? loras.map((l) => `${l.name} @ ${l.strength}`).join(', ') : 'none',
  references: staged.map((s) => s.label),
  width: W,
  height: H
};
