// Extends an existing MiniMax H3 clip: generates a continuation that carries
// BOTH the video and the soundtrack forward, so there is no audio seam.
//
// The mechanism is MiniMaxH3AddGuide (ComfyUI 0.34.0+). Rather than only
// first/last frame, it anchors an image AND an audio guide at any frame of the
// new clip. The documented continuation recipe is to feed the tail of the
// previous clip in at frame 0.
//
// Without it, the only way to continue a shot was to take the last frame and
// use it as first_frame - which keeps the picture continuous but restarts the
// soundtrack from nothing, and you hear the join.
const axios = require('axios');
const insforgeUrl = $insforgeUrl;
const insforgeApiKey = $insforgeApiKey;
const comfyUrl = $comfyUrl;
const comfyRoot = $comfyRoot;
const authHeaders = { Authorization: `Bearer ${insforgeApiKey}` };
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

// The guide clip must be a valid MiniMax length: 17k + 5 frames. 22 is the
// documented choice - long enough to establish motion and audio continuity,
// short enough to leave most of the new clip free.
const GUIDE_FRAMES = 22;
const FPS = 24;

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
// The source is either another MiniMax clip (Image/Text to Video) or a shot
// (Ref to Video). Both render MiniMax H3 video; they just live in different
// tables, so normalise them to { video_path, length } here.
let source = null;
let sourceKind = null;
if (clip.source_clip_id) {
  const srcRes = await axios.get(`${insforgeUrl}/api/database/records/minimax_clips`, {
    params: { id: `eq.${clip.source_clip_id}`, select: 'id,video_path,length' },
    headers: authHeaders
  });
  const row = (srcRes.data || [])[0];
  if (row) {
    source = { id: row.id, video_path: row.video_path, length: row.length };
    sourceKind = 'clip';
  }
} else if (clip.source_shot_id) {
  const srcRes = await axios.get(`${insforgeUrl}/api/database/records/shots`, {
    params: { id: `eq.${clip.source_shot_id}`, select: 'id,video_path,length_frames' },
    headers: authHeaders
  });
  const row = (srcRes.data || [])[0];
  if (row) {
    // Ref to Video shots default to 124 frames when length_frames was never set.
    source = { id: row.id, video_path: row.video_path, length: row.length_frames || 124 };
    sourceKind = 'shot';
  }
} else {
  return { error: 'This clip has no source to extend from.' };
}

if (!source) return { error: 'The ' + (clip.source_clip_id ? 'clip' : 'shot') + ' being extended no longer exists.' };
if (!source.video_path) return { error: 'The ' + sourceKind + ' being extended has no rendered video yet.' };
if (source.length < GUIDE_FRAMES) {
  return { error: `The source is only ${source.length} frames; at least ${GUIDE_FRAMES} are needed to continue from.` };
}

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

// LoadVideo only lists files in ComfyUI's input/ folder, but rendered clips
// live in output/. Copy rather than re-upload - the file is already on this
// machine and can be hundreds of megabytes.
let stagedName;
try {
  const fs = require('fs');
  const path = require('path');
  const srcAbs = path.join(comfyRoot, source.video_path);
  if (!fs.existsSync(srcAbs)) {
    const msg = 'The source video is missing on disk: ' + srcAbs;
    await updateClip({ status: 'failed', error_message: msg });
    return { action: 'error', reason: msg };
  }
  const ext = path.extname(srcAbs) || '.mp4';
  const relDir = movie.slug + '/_minimax_extend';
  const destDir = path.join(comfyRoot, 'input', relDir);
  fs.mkdirSync(destDir, { recursive: true });
  stagedName = relDir + '/source_' + clipId + ext;
  fs.copyFileSync(srcAbs, path.join(comfyRoot, 'input', stagedName));
} catch (e) {
  const msg = 'Could not stage the source video: ' + (e && e.message ? e.message : String(e));
  await updateClip({ status: 'failed', error_message: msg });
  return { action: 'error', reason: msg };
}

// New clip length, snapped to the model's 17k+5 grid and clamped to its
// trained range, exactly as the other generators do.
const rawLen = Math.max(5, Math.round(clip.length || 124));
const length = Math.min(362, Math.max(124, rawLen + ((5 - (rawLen % 17)) % 17) + (rawLen % 17 > 5 ? 17 : 0)));
const width = clip.width || source.width;
const height = clip.height || source.height;

// Where the guide clip starts inside the source, in frames and in seconds.
//
// The window normally ends on the source's last frame. `guideEndFrame` moves
// it earlier, which is the whole point of the frame picker: if a character
// walks out of shot before the end, extending from the true last frame gives
// the model no pixels of them to work from and it invents someone new. Ending
// the window on the last frame where the cast is still present keeps their
// identity - at the cost of dropping the tail of the source clip.
const lastFrame = source.length - 1;
let guideEnd = lastFrame;
if (clip.guide_end_frame !== null && clip.guide_end_frame !== undefined) {
  const asked = Math.round(Number(clip.guide_end_frame));
  if (Number.isFinite(asked)) {
    // The window needs GUIDE_FRAMES of source behind it, so it cannot end
    // earlier than that - and it can never run past the clip.
    guideEnd = Math.min(lastFrame, Math.max(GUIDE_FRAMES - 1, asked));
  }
}
const guideStart = guideEnd - GUIDE_FRAMES + 1;
const guideStartSeconds = guideStart / FPS;
const guideDurationSeconds = GUIDE_FRAMES / FPS;

const g = {
  '119': { class_type: 'VAELoader', inputs: { vae_name: 'minimax_h3_video_vae_fp16.safetensors' } },
  '120': { class_type: 'VAELoader', inputs: { vae_name: 'minimax_h3_audio_vae_fp32.safetensors' } },
  '127': { class_type: 'UNETLoader', inputs: { unet_name: 'minimax_h3_fl2va_pruned_int8_convrot.safetensors', weight_dtype: 'default' } },
  '128': { class_type: 'CLIPLoader', inputs: { clip_name: 'qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors', type: 'minimax', device: 'default' } },
  '134': { class_type: 'PathchSageAttentionKJ', inputs: { model: ['127', 0], sage_attention: 'auto', allow_compile: false } },
  '137': { class_type: 'LoraLoaderModelOnly', inputs: { model: ['134', 0], lora_name: 'minimax_h3_turbo_v4_step600_ema_pruned_comfyui.safetensors', strength_model: 1 } },
  '149': { class_type: 'MiniMaxH3SigmaShift', inputs: { model: ['137', 0], shift_video: 12, shift_audio: 5.5 } },

  // --- the tail of the previous clip, video and audio together ---
  '210': { class_type: 'LoadVideo', inputs: { file: stagedName } },
  '211': { class_type: 'GetVideoComponents', inputs: { video: ['210', 0] } },
  '212': { class_type: 'ImageFromBatch', inputs: { image: ['211', 0], batch_index: guideStart, length: GUIDE_FRAMES } },
  '213': { class_type: 'TrimAudioDuration', inputs: { audio: ['211', 1], start_index: guideStartSeconds, duration: guideDurationSeconds } },

  // Text conditioning and an empty AV latent for the new clip. No first_frame:
  // continuity comes from the guide below, which carries the audio too.
  '131': { class_type: 'MiniMaxH3ImageToVideo', inputs: { clip: ['128', 0], vae: ['119', 0], prompt: clip.prompt, width, height, length } },

  // Anchor the previous clip's tail at frame 0 of the new one.
  '132': { class_type: 'MiniMaxH3AddGuide', inputs: {
    positive: ['131', 0], latent: ['131', 1], frame_idx: 0,
    vae: ['119', 0], audio_vae: ['120', 0], image: ['212', 0], audio: ['213', 0]
  }},

  '123': { class_type: 'KSamplerSelect', inputs: { sampler_name: 'er_sde' } },
  '124': { class_type: 'BasicScheduler', inputs: { model: ['149', 0], scheduler: 'simple', steps: 8, denoise: 1 } },
  // The guider takes the GUIDED conditioning, not the raw one from 131.
  '126': { class_type: 'BasicGuider', inputs: { model: ['149', 0], conditioning: ['132', 0] } },
  '129': { class_type: 'RandomNoise', inputs: { noise_seed: Math.floor(Math.random() * 1e15) } },
  '125': { class_type: 'SamplerCustomAdvanced', inputs: { noise: ['129', 0], guider: ['126', 0], sampler: ['123', 0], sigmas: ['124', 0], latent_image: ['131', 1] } },
  '122': { class_type: 'VAEDecode', inputs: { samples: ['125', 0], vae: ['119', 0] } },
  '121': { class_type: 'VAEDecodeAudio', inputs: { samples: ['125', 0], vae: ['120', 0] } },
  '130': { class_type: 'CreateVideo', inputs: { images: ['122', 0], audio: ['121', 0], fps: FPS, bit_depth: 8 } },
  '92': { class_type: 'SaveVideo', inputs: { video: ['130', 0], filename_prefix: movie.slug + '/_minimax_extend/clip_' + clipId, format: 'auto', codec: 'auto' } }
};

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
  const msg = 'Extend enqueue failed: ' + JSON.stringify((r && r.data && r.data.node_errors) || (r && r.data)).slice(0, 1000);
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
  const msg = 'Extend failed in ComfyUI: ' + JSON.stringify(rec.status.messages).slice(0, 1000);
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
  const msg = 'Extend produced no video output.';
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
        source: '16-MiniMax-Extend',
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
          camera: clip.camera || null,
          source_clip_id: clip.source_clip_id || null
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

return {
  action: 'complete',
  clipId,
  extendedFrom: source.id,
  extendedFromKind: sourceKind,
  guideFrames: GUIDE_FRAMES,
  guideStartFrame: guideStart,
  guideEndFrame: guideEnd,
  newLength: length,
  videoPath,
  promptId: pid
};
