// Generates the reference shots face QA actually needs, from one photo.
//
// Why this exists: the original reference set was built for a human to look at,
// not for a recogniser. Measured against buffalo_l on this project's own data:
//
//   Turnaround   four heads in a 1536x640 frame -> face ~51px -> REJECTED
//   CloseUp      "MACRO EXTREME CLOSE-UP"       -> no face detected at all
//   Portrait     head and shoulders             -> 164-232px  OK
//   UpperTorso   waist up                       -> 143-173px  OK
//   FBody        full length                    -> 92-104px   marginal
//
// buffalo_l recognises from a 112px crop and needs the whole head plus margin,
// so a macro crop defeats it as surely as a tiny one. These shots are framed for
// that: head and shoulders, head fully in frame, face landing 300px+.
//
// Several angles rather than one, because the face model is the MEAN of the
// reference embeddings - a single frontal photo bakes in that pose, while front
// plus both three-quarters averages to identity.
const axios = require('axios');
const fs = require('fs');
const path = require('path');

const insforgeUrl = $insforgeUrl;
const insforgeApiKey = $insforgeApiKey;
const comfyUrl = $comfyUrl;
const authHeaders = { Authorization: `Bearer ${insforgeApiKey}` };

const COMFY_ROOT = String($comfyRoot || 'C:/ComfyUI2').replace(/[\\/]+$/, '');
const COMFY_INPUT = COMFY_ROOT + '/input';

const SHEET = {
  kind: 'sheet',
  width: 1080,
  height: 1080,
  prompt:
    'Create a professional character reference sheet based strictly on the uploaded reference ' +
    'image. Use a clean, neutral plain background and present the sheet as a technical model ' +
    'turnaround while matching the exact visual style of the reference. ' +
    'Arrange the composition into two horizontal rows. ' +
    'Top row: four full-body standing views placed side-by-side in this order: ' +
    'front view, left profile view, right profile view, back view. ' +
    'Bottom row: three highly detailed close-ups aligned beneath the full-body row in this ' +
    'order: one front view, one left profile view, one right profile view.'
};

const QA_SHOTS = [
  {
    kind: 'qa_front',
    label: 'facing the camera straight on, eyes to lens'
  },
  {
    kind: 'qa_threequarter_left',
    label: 'turned three-quarters to their left, looking slightly off camera'
  },
  {
    kind: 'qa_threequarter_right',
    label: 'turned three-quarters to their right, looking slightly off camera'
  },
  {
    kind: 'qa_low_angle',
    label: 'facing the camera with the head tilted slightly down, camera a little below eye level'
  }
];

// The medium the character is drawn in.
//
// This has to be asserted - "a photograph of..." genuinely helps a live actor
// hold together - but asserting the WRONG one overrides the reference latent
// and wins. Anime characters were coming back as live people for exactly that
// reason: the word "photograph" beat the style in the reference image.
const STYLES = {
  photographic: { noun: 'A photograph', medium: 'photographic' },
  anime: { noun: 'An anime illustration', medium: 'anime illustration, cel shaded, clean line art' },
  cartoon: { noun: 'A cartoon illustration', medium: 'cartoon illustration, bold outlines, flat colour' },
  '3d_animated': { noun: 'A 3D animated film still', medium: '3D animated film render' }
};

// Assigned once the character is known; nothing renders before that.
let STYLE = STYLES.photographic;

// Shared framing. Says nothing about a face, because whether there is one to
// show depends on the character.
function framing() {
  return (
    'Head-and-shoulders composition, cropped at the upper chest. The whole head is inside the frame ' +
    'with clear space above the hair and below the chin - do not crop the top of the head. ' +
    'Even soft lighting, plain mid-grey background, sharp focus, ' + STYLE.medium + ', ' +
    'no text, no watermark, no border.'
  );
}

// One lead-in for every character. It names no facial feature at all, so it
// cannot contradict a mask, a visor or a set of glowing lenses.
function shotLead() {
  return (
    STYLE.noun + ' of the same character as the reference image, identical in every detail - ' +
    'same head, same costume, same colours. Change nothing about them. '
  );
}

// Only for characters actually marked as never seen unmasked.
//
// This sentence used to be part of SHOT_LEAD, so every character got it. The
// words "mask", "helmet", "hood" and "visor" are what the model acts on - it
// does not read "stays on and is never removed" as a condition attached to
// headwear that is not there, it reads four nouns and puts one on the subject.
// Naming a thing in order to protect it is the same mistake as naming it in
// order to forbid it: an unmasked character must not hear the word at all.
const KEEP_COVERING =
  'Any mask, helmet, hood or visor stays on and is never removed. ';

function buildPrompt(shot, faceCovered) {
  return shotLead() + (faceCovered ? KEEP_COVERING : '') + shot.label + '. ' + framing();
}

let parsed;
try {
  parsed = JSON.parse(($flow.input || '').toString());
} catch (e) {
  return { error: 'Expected JSON input {"characterId":"..."}' };
}

const characterId = parsed.characterId;
if (!characterId) return { error: 'Pick a character.' };

const charRes = await axios.get(`${insforgeUrl}/api/database/records/characters`, {
  params: {
    id: `eq.${characterId}`,
    select: 'id,name,movie_id,face_covered,render_style,lora_path,lora_strength_model,lora_strength_clip'
  },
  headers: authHeaders
});
const character = (charRes.data || [])[0];
if (!character) return { error: 'Character not found.' };

STYLE = STYLES[character.render_style] || STYLES.photographic;

const movieRes = await axios.get(`${insforgeUrl}/api/database/records/movies`, {
  params: { id: `eq.${character.movie_id}`, select: 'id,slug,bucket_name' },
  headers: authHeaders
});
const movie = (movieRes.data || [])[0];
if (!movie) return { error: 'Movie not found.' };

// Pick the source image.
//
// Versions are walked in ORDER - version 1 first, then 2, and so on - rather
// than newest-first. Version 1 is the original reference set, which is where the
// full-body and turnaround images live; the later versions are generated qa_*
// shots that show the head and shoulders only. A sheet built from a face crop
// has to invent the whole costume, which is what happened before this.
//
// Within a version the kind that best suits the job wins: a sheet wants the
// body, the qa_* angles want the face.
const SHEET_PREFERENCE = ['fbody', 'turnaround', 'uppertorso', 'portrait', 'closeup'];
const FACE_PREFERENCE = ['closeup', 'portrait', 'uppertorso', 'qa_front', 'fbody', 'turnaround'];

function pickSource(images, forSheet) {
  const usable = images.filter((i) => i.image_path || i.storage_key);
  if (!usable.length) return null;

  // An image the operator uploaded themselves always wins. They chose it
  // deliberately, which beats any rule about versions or kinds - and it is the
  // whole point of being able to add your own reference. Earliest version
  // first among uploads, matching the walk below.
  // The column stores 'uploaded'. Matching on 'upload' - as this did since it
  // was written - never matched a single row, so a hand-picked reference was
  // silently ignored in favour of whatever the pipeline had generated. Both
  // spellings are accepted so a future rename cannot repeat it quietly.
  const uploads = usable
    .filter((i) => /^upload/i.test(String(i.source || '')))
    .sort((a, b) => (Number(a.version) || 1) - (Number(b.version) || 1));
  if (uploads.length) return uploads[0];

  const order = forSheet ? SHEET_PREFERENCE : FACE_PREFERENCE;
  const rank = (i) => {
    const at = order.indexOf(String(i.kind || '').toLowerCase());
    return at < 0 ? order.length : at;
  };

  for (const version of [...new Set(usable.map((i) => Number(i.version) || 1))].sort((a, b) => a - b)) {
    const inVersion = usable.filter((i) => (Number(i.version) || 1) === version);
    inVersion.sort((a, b) => rank(a) - rank(b));
    if (inVersion.length) return inVersion[0];
  }
  return usable[0];
}
const imgRes = await axios.get(`${insforgeUrl}/api/database/records/character_images`, {
  params: {
    character_id: `eq.${characterId}`,
    select: 'id,kind,image_path,storage_key,source,version,created_at',
    order: 'created_at.desc'
  },
  headers: authHeaders
});
const images = imgRes.data || [];
let source = null;
if (parsed.sourceImageId) {
  source = images.find((i) => i.id === parsed.sourceImageId) || null;
  if (!source) return { error: 'That source image no longer exists.' };
} else {
  source = pickSource(images, (parsed.mode || '') === 'sheet');
}
if (!source) {
  return { error: `${character.name} has no images yet. Upload a photo first, then create the QA shots from it.` };
}

// ComfyUI's LoadImage reads from its own input folder, so an image that lives in
// InsForge storage has to be staged there first.
fs.mkdirSync(COMFY_INPUT, { recursive: true });
let loadImageName;
if (source.image_path) {
  // LoadImage only ever reads from ComfyUI's input/ folder. Stored paths point
  // at either input/ or output/, and anything the pipeline generated - QA
  // shots, sheets, renders - lives in output/. Passing one of those through
  // unchanged made ComfyUI reject the prompt outright, so no job was queued and
  // nothing appeared anywhere. Generated sources are copied in first.
  const norm = String(source.image_path).split(String.fromCharCode(92)).join('/');
  const isInput = /^input\//i.test(norm);
  const rel = isInput ? norm.replace(/^input\//i, '') : norm;
  const full = path.join(COMFY_ROOT, isInput ? 'input' : '', ...rel.split('/').filter(Boolean));
  if (!fs.existsSync(full)) {
    return { error: 'That source image is missing on disk: ' + source.image_path };
  }
  if (isInput) {
    loadImageName = rel;
  } else {
    const stagedDir = path.join(COMFY_INPUT, '_qa_sources');
    fs.mkdirSync(stagedDir, { recursive: true });
    const base = 'src_' + norm.replace(/[^A-Za-z0-9._-]/g, '_').slice(-70);
    fs.copyFileSync(full, path.join(stagedDir, base));
    loadImageName = '_qa_sources/' + base;
  }
} else if (source.storage_key) {
  const strategyRes = await axios.get(
    `${insforgeUrl}/api/storage/buckets/${movie.bucket_name}/download-strategy/objects/${encodeURIComponent(source.storage_key)}`,
    { headers: authHeaders }
  );
  const strategy = strategyRes.data;
  const fileRes = await axios.get(strategy.url, {
    headers: strategy.method === 'direct' ? authHeaders : {},
    responseType: 'arraybuffer'
  });
  const stagedDir = path.join(COMFY_INPUT, '_qa_sources');
  fs.mkdirSync(stagedDir, { recursive: true });
  const base = 'qa_src_' + source.id + path.extname(source.storage_key || '.png');
  fs.writeFileSync(path.join(stagedDir, base), Buffer.from(fileRes.data));
  loadImageName = '_qa_sources/' + base;
} else {
  return { error: 'That source image has neither a file path nor a storage key.' };
}

// New shots land as their own version, beside whatever is already there, so
// nothing that has already been rendered against is overwritten.
const existing = images.map((i) => Number(i.version) || 1);
const version = (existing.length ? Math.max.apply(null, existing) : 0) + 1;

const W = 1024;
const H = 1024;
// Inside the movie's own folder, matching where the character generator
// writes. This used to be a root-level _CharacterRefs/<slug>/... tree, which
// put a project's characters outside the project.
const prefix = `${movie.slug}/_CharacterRefs/${character.name}/QA_v${version}`;

// The character's LoRA, if it has one. Same three columns the character
// generator reads, so a generated character and its QA set are rendered with
// the same identity weights - a LoRA on one and not the other is exactly the
// inconsistency Face QA is supposed to be measuring.
const lora = character.lora_path || null;
const loraStrengthModel = character.lora_strength_model;
const loraStrengthClip = character.lora_strength_clip;

function graph(shot, seed, w, h) {
  const wf = {
    '1': { class_type: 'UNETLoader', inputs: { unet_name: 'flux-2-klein-9b.safetensors', weight_dtype: 'default' } },
    '2': { class_type: 'CLIPLoader', inputs: { clip_name: 'qwen_3_8b_fp8mixed.safetensors', type: 'flux2', device: 'default' } },
    '3': { class_type: 'VAELoader', inputs: { vae_name: 'flux2-vae.safetensors' } },
    '5': { class_type: 'LoadImage', inputs: { image: loadImageName } },
    '6': { class_type: 'FluxKontextImageScale', inputs: { image: ['5', 0] } },
    '7': { class_type: 'VAEEncode', inputs: { pixels: ['6', 0], vae: ['3', 0] } },
    '11': { class_type: 'EmptyFlux2LatentImage', inputs: { width: w, height: h, batch_size: 1 } },
    '12': { class_type: 'Flux2Scheduler', inputs: { steps: Number(parsed.steps) || 8, width: w, height: h } },
    '13': { class_type: 'KSamplerSelect', inputs: { sampler_name: 'euler' } },
    '14': { class_type: 'RandomNoise', inputs: { noise_seed: seed } },
    '16': {
      class_type: 'SamplerCustomAdvanced',
      inputs: { noise: ['14', 0], guider: ['15', 0], sampler: ['13', 0], sigmas: ['12', 0], latent_image: ['11', 0] }
    },
    '17': { class_type: 'VAEDecode', inputs: { samples: ['16', 0], vae: ['3', 0] } },
    '18': { class_type: 'SaveImage', inputs: { images: ['17', 0], filename_prefix: `${prefix}/${shot.kind}` } }
  };

  // Both the text encode and the sampler have to come off the LoRA, not off
  // the raw loaders - wiring only the model leaves the CLIP side untrained and
  // the likeness half-applied.
  let modelRef = ['1', 0];
  let clipRef = ['2', 0];
  if (lora) {
    wf['4'] = {
      class_type: 'LoraLoader',
      inputs: {
        model: ['1', 0],
        clip: ['2', 0],
        lora_name: lora,
        strength_model: loraStrengthModel,
        strength_clip: loraStrengthClip
      }
    };
    modelRef = ['4', 0];
    clipRef = ['4', 1];
  }

  wf['8'] = {
    class_type: 'CLIPTextEncode',
    inputs: { clip: clipRef, text: shot.promptOverride || buildPrompt(shot, !!character.face_covered) }
  };
  // The reference latent is what carries the likeness into the new angle;
  // without it this is just a text-to-image of a stranger.
  wf['9'] = { class_type: 'ReferenceLatent', inputs: { conditioning: ['8', 0], latent: ['7', 0] } };
  wf['10'] = { class_type: 'ConditioningZeroOut', inputs: { conditioning: ['9', 0] } };
  wf['15'] = {
    class_type: 'CFGGuider',
    inputs: { cfg: 1, model: modelRef, positive: ['9', 0], negative: ['10', 0] }
  };
  return wf;
}

async function runShot(shot, seed, w, h) {
  const q = await axios.post(`${comfyUrl}/prompt`, { prompt: graph(shot, seed, w, h) });
  const promptId = q.data.prompt_id;
  // 10 minutes, not 20. A shot that has not appeared by then is wedged, and a
  // rejected prompt - which is what a bad source path produces - never appears
  // at all. Waiting twice as long to say so helps nobody.
  for (let i = 0; i < 120; i++) {
    await new Promise((r) => setTimeout(r, 5000));
    const h = await axios.get(`${comfyUrl}/history/${promptId}`);
    const entry = h.data[promptId];
    if (!entry) continue;
    const status = entry.status || {};
    if (status.status_str === 'error') {
      const msg = (status.messages || []).filter((m) => m[0] === 'execution_error');
      return { kind: shot.kind, error: JSON.stringify(msg).slice(0, 300) };
    }
    for (const out of Object.values(entry.outputs || {})) {
      for (const im of out.images || []) {
        const rel = (im.subfolder ? im.subfolder + '/' : '') + im.filename;
        return { kind: shot.kind, path: `output/${rel}` };
      }
    }
    if (status.completed) return { kind: shot.kind, error: 'finished with no image' };
  }
  return { kind: shot.kind, error: 'timed out waiting for ComfyUI' };
}

const baseSeed = Number(parsed.seed) || Math.floor(Math.random() * 1e9);
// mode 'sheet' produces one tall multi-view sheet; anything else produces the
// four QA angles. Both share the source-image staging and versioning above.
const wantSheet = (parsed.mode || '') === 'sheet';

const made = [];
const failed = [];

if (wantSheet) {
  const r = await runShot(
    {
      kind: SHEET.kind,
      label: '',
      promptOverride: SHEET.prompt
    },
    baseSeed,
    SHEET.width,
    SHEET.height
  );
  if (r.error) failed.push(r);
  else made.push(r);
} else {
  for (let i = 0; i < QA_SHOTS.length; i++) {
    // One seed per shot, derived from a single base so a run is reproducible.
    const r = await runShot(QA_SHOTS[i], baseSeed + i, W, H);
    if (r.error) failed.push(r);
    else made.push(r);
  }
}

if (made.length) {
  const rows = made.map((m) => ({
    character_id: characterId,
    kind: m.kind,
    image_path: m.path,
    version: version,
    source: 'generated'
  }));
  const ins = await axios.post(`${insforgeUrl}/api/database/records/character_images`, rows, {
    headers: { ...authHeaders, 'Content-Type': 'application/json' }
  });
  if (ins.status >= 300) return { error: 'Images were generated but could not be saved.' };
}

return {
  action: made.length ? 'complete' : 'error',
  character: character.name,
  version: version,
  sourceImage: loadImageName,
  created: made.map((m) => m.kind),
  failed: failed,
  faceCovered: !!character.face_covered,
  renderStyle: character.render_style || 'photographic',
  lora: lora || null,
  mode: wantSheet ? 'sheet' : 'qa',
  note: wantSheet
    ? 'A reference sheet for a person to work from. Its heads are small by design, so it is NOT ' +
      'used for face QA - the qa_* shots exist for that.'
    : character.face_covered
    ? 'Generated with the mask kept on, since this character is marked as never seen unmasked. ' +
      'Check the shots still show the headwear - if Klein removed it, the source photo may not ' +
      'show it clearly enough to hold on to.'
    : 'These are framed for face recognition - head and shoulders, whole head in frame. ' +
      'Score the character on the Face QA tab to confirm the set reads as one person.'
};
