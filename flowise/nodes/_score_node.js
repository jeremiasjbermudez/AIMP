// Score generation, deliberately separate from clip rendering.
//
// MiniMax H3 writes each clip's audio independently, so music generated inside
// clips can never match across a cut - different key, tempo and instrumentation
// every time. The fix is not a better prompt: it is to keep score OUT of the
// clips (the beat prompt already sends non_diegetic_music: N/A) and generate one
// continuous piece here, laid under the assembled edit the way a film is scored.
const axios = require('axios');
const insforgeUrl = $insforgeUrl;
const insforgeApiKey = $insforgeApiKey;
const comfyUrl = $comfyUrl;
const comfyRoot = $comfyRoot;
// @include llm
// ---------------------------------------------------------------------------
const authHeaders = { Authorization: `Bearer ${insforgeApiKey}` };
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

let parsed;
try {
  parsed = JSON.parse(($flow.input || '').toString());
} catch (e) {
  return { error: 'Expected JSON input {"scoreId": "<uuid>"}.' };
}
// --- caption enhancer -------------------------------------------------------
// MiniMax Music 3 wants a three-section brief; typing one every time is a chore
// and forgetting a section quietly costs you the render. This takes whatever
// you wrote - even a single word - and fills in the rest.
if (parsed.action === 'enhance') {
  const draft = String(parsed.draft || '').trim();
  if (!draft) return { error: 'Nothing to enhance.' };
  const hasLyrics = !!parsed.hasLyrics;

  const system = [
    'You write captions for the MiniMax Music 3 model. Output ONLY the caption.',
    '',
    'The caption is exactly three sections, in this order, each on its own line and separated by a blank line:',
    'Global Metadata: <genre and sub-genre>. <BPM> BPM, <key>, <scale or mode>. <how the piece opens, develops and ends>. <where it would be heard>. <production character: mix, texture, space>.',
    'Vocal Details: <describe the voice> OR a statement that it is instrumental.',
    'Arrangement: <the instruments, what carries the melody, what holds the low end, what enters and leaves across the piece>.',
    '',
    'Rules:',
    '- Keep whatever the user specified. Never contradict it. Fill in only what is missing.',
    '- Commit to concrete values. Choose a real BPM number, a real key and a real scale. Never write a range, a placeholder, or square brackets.',
    hasLyrics
      ? '- The user supplied lyrics, so this is a SONG. Vocal Details must describe the voice: gender, timbre, delivery, harmonies, effects.'
      : '- The user supplied NO lyrics. Vocal Details must be exactly: Instrumental, no vocals, no vocal samples.',
    '- Write plain prose. No markdown, no bullet points, no headings beyond the three section labels, no commentary before or after.',
    '- Aim for 400-700 characters in total.'
  ].join(String.fromCharCode(10));

  const res = await llmChat(
    {
      model: ollamaModel,
      stream: false,
      think: false,
      options: { temperature: 0.7 },
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: draft }
      ]
    },
    { timeout: 300000 }
  );
  let caption = ((res.data && res.data.message && res.data.message.content) || '').trim();
  // Strip any code fence or lead-in the model adds despite the instruction.
  caption = caption.replace(/^```[a-zA-Z]*\s*/, '').replace(/```\s*$/, '').trim();
  const cut = caption.search(/Global Metadata:/i);
  if (cut > 0) caption = caption.slice(cut).trim();

  const missing = ['Global Metadata:', 'Vocal Details:', 'Arrangement:'].filter(
    (h) => caption.toLowerCase().indexOf(h.toLowerCase()) === -1
  );
  // A caption that still carries brackets is the exact failure this replaces.
  const placeholders = /\[[^\]]{3,}\]/.test(caption);
  if (missing.length || placeholders) {
    return {
      error:
        'The model did not return a usable caption' +
        (missing.length ? ' (missing: ' + missing.join(', ') + ')' : ' (it left placeholders in)') +
        '. Try again, or write it by hand.'
    };
  }
  return { caption, model: ollamaModel, hadLyrics: hasLyrics };
}

const scoreId = parsed.scoreId;
if (!scoreId) return { error: 'Missing scoreId.' };

const rowRes = await axios.get(`${insforgeUrl}/api/database/records/scores`, {
  params: { id: `eq.${scoreId}`, select: '*' },
  headers: authHeaders
});
const row = (rowRes.data || [])[0];
if (!row) return { error: `No score found with id ${scoreId}.` };

const movieRes = await axios.get(`${insforgeUrl}/api/database/records/movies`, {
  params: { id: `eq.${row.movie_id}`, select: 'slug,bucket_name' },
  headers: authHeaders
});
const movie = (movieRes.data || [])[0];
if (!movie) return { error: 'Movie not found.' };

async function update(patch) {
  await axios.patch(`${insforgeUrl}/api/database/records/scores`, patch, {
    params: { id: `eq.${scoreId}` },
    headers: { ...authHeaders, 'Content-Type': 'application/json', Prefer: 'return=minimal' }
  });
}

await update({ status: 'rendering', error_message: null });

const prefix = movie.slug + '/_scores/score_' + scoreId;
const seed = Number(row.seed) > 0 ? Number(row.seed) : Math.floor(Math.random() * 1e15);
let g;

if (row.generator === 'sonilo_video') {
  // Scores TO PICTURE: the model watches the cut and writes music that follows
  // it. Only meaningful once something has been assembled, so it takes a clip.
  // The video is either a clip this project rendered, or one picked off disk
  // and uploaded - clip ids are hard to recognise in a list, so a file is often
  // the easier way to say which cut to score.
  if (!row.source_clip_id && !row.source_key) {
    const msg = 'Score to picture needs a video to watch.';
    await update({ status: 'failed', error_message: msg });
    return { action: 'error', reason: msg };
  }

  let stagedName;
  try {
    const fs = require('fs');
    const path = require('path');
    const relDir = movie.slug + '/_scores';
    fs.mkdirSync(path.join(comfyRoot, 'input', relDir), { recursive: true });

    if (row.source_key) {
      // Fully encoded: an uploaded filename can contain %, [ ] and spaces, and
      // an unencoded key comes back as a JSON error that then gets written to
      // disk as if it were the media.
      const url = `${insforgeUrl}/api/storage/buckets/${movie.bucket_name}/objects/` +
        encodeURIComponent(row.source_key);
      const res = await axios.get(url, { headers: authHeaders, responseType: 'arraybuffer' });
      const ext = (String(row.source_filename || '').split('.').pop() || 'mp4').replace(/[^a-zA-Z0-9]/g, '') || 'mp4';
      stagedName = relDir + '/src_' + scoreId + '.' + ext;
      fs.writeFileSync(path.join(comfyRoot, 'input', stagedName), Buffer.from(res.data));
    } else {
      const clipRes = await axios.get(`${insforgeUrl}/api/database/records/minimax_clips`, {
        params: { id: `eq.${row.source_clip_id}`, select: 'id,video_path' },
        headers: authHeaders
      });
      const clip = (clipRes.data || [])[0];
      if (!clip || !clip.video_path) {
        const msg = 'The chosen clip has no rendered video.';
        await update({ status: 'failed', error_message: msg });
        return { action: 'error', reason: msg };
      }
      // LoadVideo only lists files under input/, and rendered clips live in
      // output/, so the file is copied across first.
      const srcAbs = path.join(comfyRoot, clip.video_path);
      if (!fs.existsSync(srcAbs)) {
        const msg = 'The clip video is missing on disk: ' + srcAbs;
        await update({ status: 'failed', error_message: msg });
        return { action: 'error', reason: msg };
      }
      const ext = path.extname(srcAbs) || '.mp4';
      stagedName = relDir + '/src_' + scoreId + ext;
      fs.copyFileSync(srcAbs, path.join(comfyRoot, 'input', stagedName));
    }
  } catch (e) {
    const msg = 'Could not stage the video: ' + (e && e.message ? e.message : String(e));
    await update({ status: 'failed', error_message: msg });
    return { action: 'error', reason: msg };
  }

  g = {
    '1': { class_type: 'LoadVideo', inputs: { file: stagedName } },
    '2': { class_type: 'SoniloVideoToMusic', inputs: { video: ['1', 0], prompt: row.prompt, seed } },
    '3': { class_type: 'SaveAudio', inputs: { audio: ['2', 0], filename_prefix: prefix } }
  };
} else if (row.generator === 'ace_step_15' || row.generator === 'ace_step_15_xl') {
  // ACE-Step 1.5, all-in-one turbo checkpoint.
  //
  // Unlike MiniMax, this model takes its musical parameters as STRUCTURED
  // inputs - bpm, key/scale, time signature - rather than hoping they are read
  // out of a prose caption. The caption generator already commits to concrete
  // values ("120 BPM, C major"), so they are parsed out and handed over
  // properly; whatever is left still goes in as tags.
  //
  // Turbo is a distilled model: it wants few steps and cfg 1, which is why
  // these differ sharply from the MiniMax branch above.
  const caption = String(row.prompt || '');

  const bpmMatch = /(\d{2,3})\s*BPM/i.exec(caption);
  const bpm = row.bpm
    ? Math.min(300, Math.max(10, Math.round(row.bpm)))
    : bpmMatch ? Math.min(300, Math.max(10, parseInt(bpmMatch[1], 10))) : 120;

  // "C major", "F# minor", "Bb minor" - the node's enum is "<root> <quality>".
  const KEY_RE = /\b([A-G](?:#|b)?)\s+(major|minor)\b/i;
  const keyMatch = KEY_RE.exec(caption);
  const keyscale = row.keyscale
    ? String(row.keyscale)
    : keyMatch
    ? keyMatch[1].charAt(0).toUpperCase() + keyMatch[1].slice(1) + ' ' + keyMatch[2].toLowerCase()
    : 'C minor';

  // Only 2, 3, 4 and 6 are offered; anything else falls back to common time.
  const tsMatch = /\b([2346])\s*\/\s*4\b/.exec(caption);
  const timesignature = ['2', '3', '4', '6'].indexOf(String(row.timesignature)) >= 0
    ? String(row.timesignature)
    : tsMatch ? tsMatch[1] : '4';

  const seconds = Math.min(1000, Math.max(5, Math.round(row.duration_seconds || 60)));

  // Optional reference track. 1.5 can take its timbre from a recording instead
  // of from adjectives - the encoded audio is attached to the conditioning by
  // ReferenceTimbreAudio.
  let refAudioName = null;
  if (row.reference_audio_key) {
    try {
      const fs = require('fs');
      const path = require('path');
      const relDir = movie.slug + '/_scores';
      fs.mkdirSync(path.join(comfyRoot, 'input', relDir), { recursive: true });
      const url = `${insforgeUrl}/api/storage/buckets/${movie.bucket_name}/objects/` +
        encodeURIComponent(row.reference_audio_key);
      const res = await axios.get(url, { headers: authHeaders, responseType: 'arraybuffer' });
      const buf = Buffer.from(res.data);
      // A failed download arrives as a small JSON body with a 200, which would
      // otherwise be written out as a .wav and fail deep inside ComfyUI.
      if (buf.length < 512 && /^\s*[{[]/.test(buf.toString('utf8').slice(0, 40))) {
        throw new Error('the server returned ' + buf.toString('utf8').slice(0, 160));
      }
      const ext = (String(row.reference_audio_filename || '').split('.').pop() || 'wav')
        .replace(/[^a-zA-Z0-9]/g, '') || 'wav';
      refAudioName = relDir + '/ref_' + scoreId + '.' + ext;
      fs.writeFileSync(path.join(comfyRoot, 'input', refAudioName), buf);
    } catch (e) {
      const msg = 'Could not stage the reference track: ' + (e && e.message ? e.message : String(e));
      await update({ status: 'failed', error_message: msg });
      return { action: 'error', reason: msg };
    }
  }
  const lyrics = String(row.lyrics || '').trim() || '[instrumental]';
  const hasLyrics = lyrics !== '[instrumental]';
  const language = String(row.language || 'en');

  // Turbo is a distilled 2.4B decoder in one all-in-one file. XL-SFT is a 4B
  // decoder shipped as split files, so it needs three loaders - and it is NOT
  // distilled, so it wants the full 50 steps with CFG on. Running it at turbo's
  // 8 steps / cfg 1 would come out worse than turbo, not better.
  const isXl = row.generator === 'ace_step_15_xl';
  const steps = isXl ? 50 : 8;
  const cfg = isXl ? 5.0 : 1.0;

  g = {};
  if (isXl) {
    g['1a'] = {
      class_type: 'UNETLoader',
      inputs: { unet_name: 'acestep_v1.5_xl_sft_bf16.safetensors', weight_dtype: 'default' }
    };
    // 1.5 always pairs a qwen3_06b base encoder with a larger LM planner;
    // that is why this is a DUAL loader and not a single CLIPLoader.
    g['1b'] = {
      class_type: 'DualCLIPLoader',
      inputs: {
        clip_name1: 'qwen_0.6b_ace15.safetensors',
        clip_name2: 'qwen_1.7b_ace15.safetensors',
        type: 'ace'
      }
    };
    g['1c'] = { class_type: 'VAELoader', inputs: { vae_name: 'ace_1.5_vae.safetensors' } };
  } else {
    g['1'] = {
      class_type: 'CheckpointLoaderSimple',
      inputs: { ckpt_name: 'ace_step_1.5_turbo_aio.safetensors' }
    };
  }
  const MODEL = isXl ? ['1a', 0] : ['1', 0];
  const CLIP = isXl ? ['1b', 0] : ['1', 1];
  const VAE = isXl ? ['1c', 0] : ['1', 2];

  Object.assign(g, {
    '2': {
      class_type: 'TextEncodeAceStepAudio1.5',
      inputs: {
        clip: CLIP,
        tags: caption,
        lyrics: lyrics,
        seed: seed,
        bpm: bpm,
        duration: seconds,
        timesignature: timesignature,
        language: language,
        keyscale: keyscale,
        // The LM planner writes an audio-code sketch before the DiT renders
        // it - the slow part, and what 1.5 adds over 1.0. ComfyUI's own tooltip
        // says to switch it off when a reference track is supplied, because the
        // reference is then carrying the character instead.
        generate_audio_codes: !refAudioName,
        cfg_scale: 2.0,
        temperature: 0.85,
        top_p: 0.9,
        top_k: 0,
        min_p: 0.0
      }
    },
    '3': { class_type: 'ConditioningZeroOut', inputs: { conditioning: ['2', 0] } },
    '4': {
      class_type: 'EmptyAceStep1.5LatentAudio',
      inputs: { seconds: seconds, batch_size: 1 }
    },
    '5': {
      class_type: 'KSampler',
      inputs: {
        model: MODEL, positive: ['2', 0], negative: ['3', 0], latent_image: ['4', 0],
        seed: seed, steps: steps, cfg: cfg, sampler_name: 'euler', scheduler: 'simple', denoise: 1
      }
    },
    '6': { class_type: 'VAEDecodeAudio', inputs: { samples: ['5', 0], vae: VAE } },
    '7': { class_type: 'SaveAudio', inputs: { audio: ['6', 0], filename_prefix: prefix } }
  });

  // The reference chain, only when a track was supplied: the audio is encoded
  // with the model's own VAE and attached to the positive conditioning as a
  // timbre latent.
  if (refAudioName) {
    g['8'] = { class_type: 'LoadAudio', inputs: { audio: refAudioName } };
    g['9'] = { class_type: 'VAEEncodeAudio', inputs: { audio: ['8', 0], vae: VAE } };
    g['10'] = { class_type: 'ReferenceTimbreAudio', inputs: { conditioning: ['2', 0], latent: ['9', 0] } };
    g['5'].inputs.positive = ['10', 0];
    // The negative is the positive zeroed out, so it follows the reference too.
    g['3'].inputs.conditioning = ['10', 0];
  }
} else {
  // MiniMax Music 3, running locally - no comfy.org session needed, which is
  // why this and not Sonilo: partner nodes take their auth token from the
  // ComfyUI web page, and a flow submitting through /prompt has no such token.
  //
  // Node-for-node the official audio_minimax_music_3 template. Two details in
  // it are not obvious and matter:
  //   - the NEGATIVE is the positive conditioning passed through
  //     ConditioningZeroOut, not an empty encode
  //   - the latent's length comes from the text encoder's FLOAT output, not
  //     from a number typed in, so the audio is exactly as long as the model
  //     decided the lyrics need
  const maxDuration = Math.min(300, Math.max(5, Math.round(row.duration_seconds || 60)));
  const hasLyrics = !!(row.lyrics && String(row.lyrics).trim());
  g = {
    '1': { class_type: 'UNETLoader', inputs: { unet_name: 'minimax_music3_dit_fp16.safetensors', weight_dtype: 'default' } },
    '2': { class_type: 'CLIPLoader', inputs: { clip_name: 'minimax_music3_text_encoder_pruned_int8_convrot.safetensors', type: 'minimax', device: 'default' } },
    '3': { class_type: 'VAELoader', inputs: { vae_name: 'minimax_music3_dav.safetensors' } },
    '4': {
      class_type: 'MiniMaxMusic3TextEncode',
      inputs: {
        clip: ['2', 0],
        caption: row.prompt,
        lyrics: row.lyrics || '',
        seed,
        max_duration: maxDuration,
        cfg_scale: 1.7,
        top_k: 50
      }
    },
    '5': { class_type: 'ConditioningZeroOut', inputs: { conditioning: ['4', 0] } },
    // The template wires the encoder's FLOAT output into `seconds`, because for
    // a SONG the lyrics decide how long it runs. With no lyrics that float
    // collapses to a few seconds - which is how a 60s request came back as 7
    // seconds of humming. So: lyrics present, trust the model; no lyrics, this
    // is an instrumental bed and the requested length is what was meant.
    '6': {
      class_type: 'EmptyMiniMaxMusic3LatentAudio',
      inputs: { seconds: hasLyrics ? ['4', 1] : maxDuration, batch_size: 1 }
    },
    '7': {
      class_type: 'KSampler',
      inputs: {
        model: ['1', 0], positive: ['4', 0], negative: ['5', 0], latent_image: ['6', 0],
        seed, steps: 30, cfg: 1.7, sampler_name: 'euler', scheduler: 'simple', denoise: 1
      }
    },
    '8': { class_type: 'VAEDecodeAudio', inputs: { samples: ['7', 0], vae: ['3', 0] } },
    '9': { class_type: 'SaveAudio', inputs: { audio: ['8', 0], filename_prefix: prefix } }
  };
}

let r;
try {
  r = await axios.post(comfyUrl + '/prompt', { prompt: g });
} catch (e) {
  const body = (e && e.response && e.response.data) || (e && e.message) || String(e);
  const msg = 'ComfyUI rejected the graph: ' + JSON.stringify(body).slice(0, 1200);
  await update({ status: 'failed', error_message: msg });
  return { action: 'error', reason: msg };
}
const pid = r && r.data && r.data.prompt_id;
if (!pid) {
  const msg = 'Enqueue failed: ' + JSON.stringify((r && r.data && r.data.node_errors) || (r && r.data)).slice(0, 1200);
  await update({ status: 'failed', error_message: msg });
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
if (!rec) return { action: 'pending', reason: 'Still generating past the check window.', promptId: pid, scoreId };
if (rec.status.status_str === 'error') {
  const msg = 'Generation failed in ComfyUI: ' + JSON.stringify(rec.status.messages).slice(0, 1200);
  await update({ status: 'failed', error_message: msg });
  return { action: 'error', reason: msg };
}

let outRel = null;
const outputs = rec.outputs || {};
for (const nid in outputs) {
  const o = outputs[nid];
  const item = (o.audio && o.audio[0]) || (o.audios && o.audios[0]);
  if (item && item.filename) outRel = (item.subfolder ? item.subfolder + '/' : '') + item.filename;
}
if (!outRel) {
  const msg = 'Generation produced no audio output.';
  await update({ status: 'failed', error_message: msg });
  return { action: 'error', reason: msg };
}

const audioPath = 'output/' + outRel;
await update({ status: 'complete', audio_path: audioPath, error_message: null });
return { action: 'complete', scoreId, audioPath, generator: row.generator, promptId: pid };
