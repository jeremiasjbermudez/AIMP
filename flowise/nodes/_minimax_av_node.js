const rawInput = ($flow.input || '').toString();
let parsed;
try { parsed = JSON.parse(rawInput); } catch (e) {
  return { error: 'Expected JSON input {"clipId": "<uuid>"}, got: ' + rawInput };
}
const clipId = parsed.clipId;
if (!clipId) return { error: 'Missing clipId in input.' };

const axios = require('axios');
const insforgeUrl = $insforgeUrl;
const insforgeApiKey = $insforgeApiKey;
const comfyUrl = $comfyUrl;
const kind = $kind;
const authHeaders = { Authorization: `Bearer ${insforgeApiKey}` };
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

const clipRes = await axios.get(`${insforgeUrl}/api/database/records/minimax_clips`, {
  params: { id: `eq.${clipId}`, select: '*' },
  headers: authHeaders
});
const clip = (clipRes.data || [])[0];
if (!clip) return { error: `No clip found with id ${clipId}.` };
if (!clip.prompt || !clip.prompt.trim()) return { error: `Clip ${clipId} has no prompt.` };

async function updateClip(patch) {
  await axios.patch(`${insforgeUrl}/api/database/records/minimax_clips`, patch, {
    params: { id: `eq.${clipId}` },
    headers: { ...authHeaders, 'Content-Type': 'application/json', Prefer: 'return=minimal' }
  });
}

const movieRes = await axios.get(`${insforgeUrl}/api/database/records/movies`, {
  params: { id: `eq.${clip.movie_id}`, select: 'slug,bucket_name' },
  headers: authHeaders
});
const movie = (movieRes.data || [])[0];
if (!movie) return { error: `Movie ${clip.movie_id} not found.` };

// Mode validation is the only thing that differs between the two flows.
// T2V ignores frames outright; I2V insists on a first frame, because
// MiniMaxH3ImageToVideo treats first_frame/last_frame as optional and would
// otherwise quietly render a plain text-to-video clip under an I2V label.
let mode;
if (kind === 't2v') {
  mode = 't2v';
} else {
  if (!clip.first_image_path) {
    const msg = `Clip ${clipId} is image-to-video but has no first image.`;
    await updateClip({ status: 'failed', error_message: msg });
    return { error: msg };
  }
  mode = clip.last_image_path ? 'i2v_first_last' : 'i2v_first';
}

await updateClip({ status: 'rendering', error_message: null, mode });

function buildMultipart(fields) {
  const boundary = '----FlowiseMiniMaxAV' + Math.random().toString(16).slice(2);
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

// Frames arrive as InsForge storage keys but LoadImage reads ComfyUI's own
// input/ folder by relative filename, so each one has to be pulled down and
// re-uploaded through ComfyUI's /upload/image first.
async function stageFromStorage(storageKey, stagedRelPath) {
  const key = encodeURIComponent(storageKey);
  const strategyRes = await axios.get(`${insforgeUrl}/api/storage/buckets/${movie.bucket_name}/download-strategy/objects/${key}`, { headers: authHeaders });
  const strategy = strategyRes.data;
  const fileHeaders = strategy.method === 'direct' ? authHeaders : {};
  const fileRes = await axios.get(strategy.url, { headers: fileHeaders, responseType: 'arraybuffer' });
  const relParts = stagedRelPath.split('/');
  const stagedFilename = relParts.pop();
  const stagedSubfolder = relParts.join('/');
  const { body, boundary } = buildMultipart({
    type: 'input', subfolder: stagedSubfolder, overwrite: 'true',
    image: { data: Buffer.from(fileRes.data), filename: stagedFilename, contentType: 'image/png' }
  });
  const upRes = await axios.post(comfyUrl + '/upload/image', body, { headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` } });
  if (upRes.status < 200 || upRes.status >= 300) {
    throw new Error('Staging frame into ComfyUI input/ failed: ' + JSON.stringify(upRes.data).slice(0, 300));
  }
  return stagedRelPath;
}

// Custom sizes are allowed from the UI, so they are snapped here as well as
// there: the video VAE needs both axes on a multiple of 16, and a request that
// misses the grid fails deep in the graph with an unhelpful shape error. The
// ceiling is a practical one - beyond roughly 2MP the model runs out of memory
// on this card rather than producing anything.
function snap16(v, fallback) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(1920, Math.max(256, Math.round(n / 16) * 16));
}
const width = snap16(clip.width, 864);
const height = snap16(clip.height, 480);
// MiniMax H3 only accepts frame counts on the 17k+5 grid, and the UI is free
// to send anything, so snap here rather than trusting the caller.
const rawLen = Math.max(5, Math.round(clip.length || 124));
const length = rawLen + (5 - (rawLen % 17)) % 17;

// Node-for-node translation of minimaxH3INT8INT4_fl2vaINT8Pruned.json, the
// locally proven fl2va configuration (SageAttention patch -> turbo LoRA ->
// SigmaShift, er_sde at 8 steps). Output is CreateVideo + SaveVideo rather
// than that graph's VHS_VideoCombine, so the history parsing below is the
// same as the R2V generator's - SaveVideo reports its file under "images".
const g = {
  '119': { class_type: 'VAELoader', inputs: { vae_name: 'minimax_h3_video_vae_fp16.safetensors' } },
  '120': { class_type: 'VAELoader', inputs: { vae_name: 'minimax_h3_audio_vae_fp32.safetensors' } },
  '127': { class_type: 'UNETLoader', inputs: { unet_name: 'minimax_h3_fl2va_pruned_int8_convrot.safetensors', weight_dtype: 'default' } },
  '128': { class_type: 'CLIPLoader', inputs: { clip_name: 'qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors', type: 'minimax', device: 'default' } },
  '134': { class_type: 'PathchSageAttentionKJ', inputs: { model: ['127', 0], sage_attention: 'auto', allow_compile: false } },
  '137': { class_type: 'LoraLoaderModelOnly', inputs: { model: ['134', 0], lora_name: 'minimax_h3_turbo_v4_step600_ema_pruned_comfyui.safetensors', strength_model: 1 } },
  '149': { class_type: 'MiniMaxH3SigmaShift', inputs: { model: ['137', 0], shift_video: 12, shift_audio: 5.5 } },
  '123': { class_type: 'KSamplerSelect', inputs: { sampler_name: 'er_sde' } },
  '124': { class_type: 'BasicScheduler', inputs: { model: ['149', 0], scheduler: 'simple', steps: 8, denoise: 1 } },
  '126': { class_type: 'BasicGuider', inputs: { model: ['149', 0], conditioning: ['131', 0] } },
  '129': { class_type: 'RandomNoise', inputs: { noise_seed: Math.floor(Math.random() * 1e15) } },
  '125': { class_type: 'SamplerCustomAdvanced', inputs: { noise: ['129', 0], guider: ['126', 0], sampler: ['123', 0], sigmas: ['124', 0], latent_image: ['131', 1] } },
  '122': { class_type: 'VAEDecode', inputs: { samples: ['125', 0], vae: ['119', 0] } },
  '121': { class_type: 'VAEDecodeAudio', inputs: { samples: ['125', 0], vae: ['120', 0] } },
  '130': { class_type: 'CreateVideo', inputs: { images: ['122', 0], audio: ['121', 0], fps: 24, bit_depth: 8 } },
  '92': { class_type: 'SaveVideo', inputs: { video: ['130', 0], filename_prefix: movie.slug + '/_minimax_' + mode + '/clip_' + clipId, format: 'auto', codec: 'auto' } }
};

const genInputs = { clip: ['128', 0], vae: ['119', 0], prompt: clip.prompt, width, height, length };

try {
  if (mode !== 't2v') {
    const firstRel = await stageFromStorage(clip.first_image_path, movie.slug + '/_minimax_frames/clip_' + clipId + '_first.png');
    g['200'] = { class_type: 'LoadImage', inputs: { image: firstRel } };
    genInputs.first_frame = ['200', 0];
    if (mode === 'i2v_first_last') {
      const lastRel = await stageFromStorage(clip.last_image_path, movie.slug + '/_minimax_frames/clip_' + clipId + '_last.png');
      g['201'] = { class_type: 'LoadImage', inputs: { image: lastRel } };
      genInputs.last_frame = ['201', 0];
    }
  }
} catch (e) {
  const msg = 'Frame staging failed: ' + (e && e.message ? e.message : String(e));
  await updateClip({ status: 'failed', error_message: msg });
  return { action: 'error', reason: msg };
}

g['131'] = { class_type: 'MiniMaxH3ImageToVideo', inputs: genInputs };

// Optional Spectrum acceleration. It patches the MODEL, forecasting some
// transformer evaluations instead of running them, so it is inserted between
// SigmaShift and the two nodes that consume the model. Off unless the clip row
// asks for it - it is an approximation, and output differs from unaccelerated
// even at the same seed.
if (clip.use_spectrum) {
  g['150'] = {
    class_type: 'SpectrumApplyMiniMaxH3',
    inputs: {
      model: ['149', 0],
      enabled: true,
      blend_weight: 0.5,
      degree: 1,
      ridge_lambda: 0.1,
      window_size: 2,
      flex_window: 0.75,
      warmup_steps: 1,
      tail_actual_steps: 1,
      max_history: 8,
      debug: false,
      history_storage: 'system_ram',
      bootstrap_first_forecast: true,
      anchor_residual_feedback: false,
      selective_rollback_correction: false,
      offline_smoothing_replay: true,
      // The author's default. Blending audio spectrally is the riskiest part
      // and this pipeline depends on the soundtrack surviving intact.
      audio_blend_weight: 0,
      offline_archive_storage: 'system_ram',
      model_aware_mode: 'off',
      model_aware_risk_threshold: 0.65,
      model_aware_trust_shrinkage: false,
      model_aware_replay_generic_correction: false,
      generic_correction_mode: 'coordinate_rls',
      generic_correction_limiter: 'hard_clip',
      generic_correction_limit: 0.4,
      generic_correction_attenuation: 'no_attenuation',
      sa_pece_forecast_policy: 'balanced'
    }
  };
  g['124'].inputs.model = ['150', 0];
  g['126'].inputs.model = ['150', 0];
}

const r = await axios.post(comfyUrl + '/prompt', { prompt: g });
const pid = r && r.data && r.data.prompt_id;
if (!pid) {
  const msg = 'MiniMax ' + mode + ' enqueue failed: ' + JSON.stringify((r && r.data && r.data.node_errors) || (r && r.data)).slice(0, 1500);
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

const rec = await waitFor(pid, 240, 10000);
if (!rec) {
  return { action: 'pending', reason: 'MiniMax generation still running past the check window.', promptId: pid, clipId };
}
if (rec.status.status_str === 'error') {
  const msg = 'MiniMax generation failed in ComfyUI: ' + JSON.stringify(rec.status.messages).slice(0, 1500);
  await updateClip({ status: 'failed', error_message: msg });
  return { action: 'error', reason: msg };
}

let outRel = null;
const outputs = rec.outputs || {};
for (const nid in outputs) {
  const o = outputs[nid];
  const candidates = o.images || o.gifs || o.videos || [];
  if (candidates[0]) {
    const f = candidates[0];
    outRel = (f.subfolder ? f.subfolder + '/' : '') + f.filename;
  }
}
if (!outRel) {
  const msg = 'MiniMax generation produced no output video (raw outputs: ' + JSON.stringify(outputs).slice(0, 800) + ')';
  await updateClip({ status: 'failed', error_message: msg });
  return { action: 'error', reason: msg };
}

const videoPath = 'output/' + outRel;
await updateClip({ status: 'complete', video_path: videoPath, error_message: null });

// The prompt library: the clip prompt that actually produced video, kept apart
// from minimax_clips so it outlives the media. The clip row holds one prompt and
// is rewritten on every re-render; this keeps each render that worked.
try {
  await axios.post(
    `${insforgeUrl}/api/database/records/prompt_log`,
    [
      {
        movie_id: clip.movie_id || null,
        kind: 'clip',
        source: '8-MiniMax-Image-To-Video',
        subject_table: 'minimax_clips',
        subject_id: clipId,
        prompt: clip.prompt || '',
        // First image and any reference pool, in order - a clip is rebuilt from
        // its opening frame as much as from its words.
        references: [
          clip.first_image_path ? { path: clip.first_image_path, label: 'first frame' } : null,
          clip.last_image_path ? { path: clip.last_image_path, label: 'last frame' } : null,
          ...(Array.isArray(clip.reference_image_paths) ? clip.reference_image_paths.map((p) => ({ path: p, label: 'reference' })) : [])
        ].filter(Boolean),
        settings: {
          mode: clip.mode,
          width: clip.width,
          height: clip.height,
          length: clip.length,
          use_spectrum: !!clip.use_spectrum,
          camera: clip.camera || null
        },
        output_path: videoPath,
        comfy_prompt_id: pid
      }
    ],
    { headers: { ...authHeaders, 'Content-Type': 'application/json' }, validateStatus: () => true }
  );
} catch (e) {
  // Never fails the render.
}

return { action: 'complete', clipId, mode, videoPath, promptId: pid };
