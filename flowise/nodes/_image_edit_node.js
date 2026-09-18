// Image Edit: FLUX.2 Klein with one or more reference images, driven from the
// admin app instead of from ComfyUI directly.
//
// The references are chained as ReferenceLatent nodes - one per image, each
// hanging off the previous conditioning - which is what lets a prompt say "the
// person from the first image, in the location from the second". Order matters,
// so it is preserved end to end and stored with the result.
const axios = require('axios');
const fs = require('fs');
const path = require('path');

const insforgeUrl = $insforgeUrl;
const insforgeApiKey = $insforgeApiKey;
const comfyUrl = $comfyUrl;
const authHeaders = { Authorization: `Bearer ${insforgeApiKey}` };

const COMFY_ROOT = 'C:/ComfyUI2';
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
// Zero references is a legitimate mode: with no ReferenceLatent in the chain
// the graph is a plain text-to-image, which is exactly what you want when there
// is nothing to carry across from an existing picture.
const incoming = Array.isArray(parsed.references) ? parsed.references : [];
if (incoming.length > 4) return { error: 'Four reference images is the sensible limit.' };

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

const W = Math.max(256, Math.min(2048, Number(parsed.width) || 1280));
const H = Math.max(256, Math.min(2048, Number(parsed.height) || 720));
const steps = Math.max(1, Math.min(40, Number(parsed.steps) || 8));
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

const wf = {
  '1': { class_type: 'UNETLoader', inputs: { unet_name: 'flux-2-klein-9b.safetensors', weight_dtype: 'default' } },
  '2': { class_type: 'CLIPLoader', inputs: { clip_name: 'qwen_3_8b_fp8mixed.safetensors', type: 'flux2', device: 'default' } },
  '3': { class_type: 'VAELoader', inputs: { vae_name: 'flux2-vae.safetensors' } },
};

// The LoRA sits between the loaders and everything downstream: both the text
// encoder and the guider must read from it, or it is loaded and ignored.
let modelRef = ['1', 0];
let clipRef = ['2', 0];
// Ids 40..47, clear of the fixed nodes above and of the per-reference ids
// below, which start at 20.
loras.forEach((l, i) => {
  const id = String(40 + i);
  wf[id] = {
    class_type: 'LoraLoader',
    inputs: {
      model: modelRef,
      clip: clipRef,
      lora_name: l.name,
      strength_model: l.strength,
      strength_clip: l.strength
    }
  };
  modelRef = [id, 0];
  clipRef = [id, 1];
});
wf['8'] = { class_type: 'CLIPTextEncode', inputs: { clip: clipRef, text: prompt.slice(0, 1800) } };

// One ReferenceLatent per image, chained. Node ids are numbered per reference so
// adding a fourth cannot collide with the fixed nodes above.
let prev = ['8', 0];
staged.forEach((s, i) => {
  const load = `${i + 2}0`;
  const scale = `${i + 2}1`;
  const enc = `${i + 2}2`;
  const refl = `${i + 2}3`;
  wf[load] = { class_type: 'LoadImage', inputs: { image: s.load } };
  wf[scale] = { class_type: 'FluxKontextImageScale', inputs: { image: [load, 0] } };
  wf[enc] = { class_type: 'VAEEncode', inputs: { pixels: [scale, 0], vae: ['3', 0] } };
  wf[refl] = { class_type: 'ReferenceLatent', inputs: { conditioning: prev, latent: [enc, 0] } };
  prev = [refl, 0];
});

// Under the movie's own folder, matching the rest of the pipeline
// (_pano, _minimax_ref, _scores) so one project is one folder.
const outPrefix = `${movie.slug}/_FluxKleinEdits/edit`;
Object.assign(wf, {
  '10': { class_type: 'ConditioningZeroOut', inputs: { conditioning: prev } },
  '11': { class_type: 'EmptyFlux2LatentImage', inputs: { width: W, height: H, batch_size: 1 } },
  '12': { class_type: 'Flux2Scheduler', inputs: { steps: steps, width: W, height: H } },
  '13': { class_type: 'KSamplerSelect', inputs: { sampler_name: 'euler' } },
  '14': { class_type: 'RandomNoise', inputs: { noise_seed: seed } },
  '15': { class_type: 'CFGGuider', inputs: { cfg: 1, model: modelRef, positive: prev, negative: ['10', 0] } },
  '16': {
    class_type: 'SamplerCustomAdvanced',
    inputs: { noise: ['14', 0], guider: ['15', 0], sampler: ['13', 0], sigmas: ['12', 0], latent_image: ['11', 0] }
  },
  '17': { class_type: 'VAEDecode', inputs: { samples: ['16', 0], vae: ['3', 0] } },
  '18': { class_type: 'SaveImage', inputs: { images: ['17', 0], filename_prefix: outPrefix } }
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
// Waits on ComfyUI's STATE, not on a clock.
//
// This used to give up after a fixed ten minutes. A wall-clock cap is a guess
// about how long work ought to take, and it is wrong in both directions: it
// declares a healthy job dead because a bigger image, a cold model load or a
// queue behind it took longer than someone once assumed, and it keeps waiting on
// a job that has actually vanished. Neither has anything to do with the clock.
//
// So: a job is alive while ComfyUI says it is running or queued. It is finished
// when history says so. It has failed only when it is in NEITHER - which means
// it is genuinely gone, cleared or crashed - and stays that way for several
// checks in a row, so one slow or dropped response cannot condemn it.
const POLL_MS = 5000;
// Consecutive polls in which ComfyUI knows nothing about the job at all.
const GONE_LIMIT = 4;
// Consecutive polls where ComfyUI could not be reached at all. Bounded because
// an unreachable server is the one case where "wait and see" never resolves.
const UNREACHABLE_LIMIT = 60;
let gone = 0;
let unreachable = 0;
const startedAt = Date.now();
for (;;) {
  await new Promise((r) => setTimeout(r, POLL_MS));

  const h = await axios.get(`${comfyUrl}/history/${promptId}`, { validateStatus: () => true });
  const entry = (h.data || {})[promptId];
  if (entry) {
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
    gone = 0;
    continue;
  }

  // Not in history yet. Still ours if ComfyUI is holding it.
  let alive = false;
  try {
    const q = await axios.get(`${comfyUrl}/queue`, { validateStatus: () => true });
    const inList = (list) => (list || []).some((row) => Array.isArray(row) && row.some((v) => v === promptId));
    alive = inList((q.data || {}).queue_running) || inList((q.data || {}).queue_pending);
    unreachable = 0;
  } catch (e) {
    // Could not ask. That says nothing about the job, so it is not evidence
    // against it - look again rather than condemning it. But not forever: if
    // ComfyUI itself has gone, "inconclusive" would loop for ever and the flow
    // would never return at all.
    if (++unreachable >= UNREACHABLE_LIMIT) {
      return await fail(
        'ComfyUI has been unreachable for ' +
          Math.round((UNREACHABLE_LIMIT * POLL_MS) / 1000) +
          's, so the job cannot be followed. It may still be running - check the ComfyUI console.'
      );
    }
    alive = true;
  }
  if (alive) {
    gone = 0;
    continue;
  }
  if (++gone >= GONE_LIMIT) {
    return await fail(
      'ComfyUI no longer has this job: it is not running, not queued and not in history after ' +
        Math.round((Date.now() - startedAt) / 1000) +
        's. It was probably cancelled or ComfyUI restarted.'
    );
  }
}

if (row) {
  await axios.patch(
    `${insforgeUrl}/api/database/records/image_edits?id=eq.${row.id}`,
    { status: 'complete', output_path: outputPath },
    { headers: { ...authHeaders, 'Content-Type': 'application/json' } }
  );
}

// The prompt library.
//
// Written HERE, after the picture exists, so the library holds prompts that
// produced something. A prompt that was enqueued and then failed, cancelled or
// abandoned is not a usable prompt and does not belong in a library you would
// rebuild the film from.
//
// It is its own table rather than a view over image_edits because it has to
// outlive the media: the point is to delete every picture and video and still be
// able to make them again. It keeps the reference paths IN ORDER, because the
// prompt addresses them by position - "the character from the first image" - and
// each of those paths is the output of another row here, which is what makes the
// whole chain replayable: regenerate in dependency order and remap each old path
// to the new one it produces.
try {
  await axios.post(
    `${insforgeUrl}/api/database/records/prompt_log`,
    [
      {
        movie_id: parsed.movieId || null,
        kind: parsed.logKind || 'frame',
        source: '26-Image-Edit',
        subject_table: parsed.subjectTable || null,
        subject_id: parsed.subjectId || null,
        position: parsed.position == null ? null : Number(parsed.position),
        scene_number: parsed.sceneNumber == null ? null : Number(parsed.sceneNumber),
        prompt: prompt,
        // `source` is the path the caller gave, not the staged copy in ComfyUI's
        // input folder. The staged name is an implementation detail that will not
        // exist on a rebuild; the source is the output of another row here, which
        // is the link that makes the chain replayable.
        references: staged.map((s) => ({ path: s.source, label: s.label })),
        settings: {
          width: W,
          height: H,
          steps: steps,
          seed: seed,
          engine: 'flux',
          loras: loras.map((l) => ({ name: l.name, strength: l.strength }))
        },
        output_path: outputPath,
        comfy_prompt_id: promptId
      }
    ],
    { headers: { ...authHeaders, 'Content-Type': 'application/json' }, validateStatus: () => true }
  );
} catch (e) {
  // Never fails the render. The picture is made and recorded on image_edits
  // either way; losing one library row is not worth losing the job over.
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
