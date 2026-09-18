// Face Fix: repaint one face in a still to match a character's references.
//
// This is the "fix the first frame" step Face QA sends you to. It is a STILL
// operation on purpose. Repainting a face across every frame of a clip flickers
// - independently corrected frames do not agree with each other, and the eye
// catches face flicker faster than anything else - so the face is fixed once,
// on the frame the clip will be re-rendered from.
//
// MASKED, not prompted. Asking a model to leave the rest of the picture alone
// does not work: a two-reference relight was told in plain words to keep the
// background and swapped it anyway. A mask enforces what a sentence only
// requests - everything outside it is untouched by construction.
//
// The graph follows _inpaint_live.js, which was tuned the hard way. Two of its
// lessons are load-bearing and must not be "tidied up":
//
//   * NO BLUR on the mask. A fixed blur radius is a thin edge on a big close-up
//     face and most of the area on a small distant one, which blends original
//     and regenerated pixels across the whole face and comes out waxy.
//
//   * NEVER invert an empty mask as a fallback. An inverted empty mask is a
//     FULL-FRAME mask, which silently opens the entire picture to denoise-1
//     regeneration. A failed detection must be a near-no-op instead.
const axios = require('axios');
const fs = require('fs');
const path = require('path');

const insforgeUrl = $insforgeUrl;
const insforgeApiKey = $insforgeApiKey;
const comfyUrl = $comfyUrl;
const comfyRoot = $comfyRoot;
const authHeaders = { Authorization: `Bearer ${insforgeApiKey}` };

let parsed;
try {
  parsed = JSON.parse(($flow.input || '').toString());
} catch (e) {
  return { error: 'Expected JSON {"imagePath":"output/...","characterId":"..."}' };
}
if (!parsed.imagePath) return { error: 'Pick an image to fix.' };
if (!parsed.characterId) return { error: 'Pick which character the face should match.' };

// ------------------------------------------------------------- the inputs
const charRes = await axios.get(`${insforgeUrl}/api/database/records/characters`, {
  params: {
    id: `eq.${parsed.characterId}`,
    select: 'id,name,movie_id,visual_anchor,render_style,lora_path,lora_strength_model,lora_strength_clip'
  },
  headers: authHeaders
});
const character = (charRes.data || [])[0];
if (!character) return { error: 'Character not found.' };

const movieRes = await axios.get(`${insforgeUrl}/api/database/records/movies`, {
  params: { id: `eq.${character.movie_id}`, select: 'id,slug' },
  headers: authHeaders
});
const movie = (movieRes.data || [])[0];
if (!movie) return { error: 'Movie not found.' };

// Face references, closest framing first. A turnaround puts the head at ~50px
// and teaches the model almost nothing about the face.
const FACE_KINDS = ['closeup', 'portrait', 'uppertorso'];
const imgRes = await axios.get(`${insforgeUrl}/api/database/records/character_images`, {
  params: { character_id: `eq.${parsed.characterId}`, select: 'kind,version,image_path' },
  headers: authHeaders
});
const refs = (imgRes.data || [])
  .filter((i) => i.image_path && FACE_KINDS.indexOf(String(i.kind).toLowerCase()) >= 0)
  .sort((a, b) => FACE_KINDS.indexOf(String(a.kind).toLowerCase()) - FACE_KINDS.indexOf(String(b.kind).toLowerCase()))
  .slice(0, 2);
if (!refs.length) {
  return { error: `${character.name} has no close-up or portrait reference to match against.` };
}

// ------------------------------------------------------- staging into input/
// LoadImage reads from ComfyUI's input tree, so anything living in output/ has
// to be copied across first.
function relOf(p) {
  return String(p).split(String.fromCharCode(92)).join('/');
}

function stage(rel) {
  const norm = relOf(rel);
  if (norm.toLowerCase().indexOf('input/') === 0) return norm.slice('input/'.length);
  const src = path.join(comfyRoot, norm);
  if (!fs.existsSync(src)) return null;
  const dest = '_facefix/' + path.basename(norm);
  const destAbs = path.join(comfyRoot, 'input', dest);
  fs.mkdirSync(path.dirname(destAbs), { recursive: true });
  fs.copyFileSync(src, destAbs);
  return dest;
}

const sourceRel = stage(parsed.imagePath);
if (!sourceRel) return { error: 'That image is missing on disk: ' + parsed.imagePath };
const refRels = refs.map((r) => stage(r.image_path)).filter(Boolean);
if (!refRels.length) return { error: 'The reference images are missing on disk.' };

// ---------------------------------------------------------------- the graph
const STYLES = {
  photographic: 'photographic',
  anime: 'anime illustration, cel shaded',
  cartoon: 'cartoon illustration',
  '3d_animated': '3D animated film render'
};
const medium = STYLES[character.render_style] || STYLES.photographic;
const instruction =
  'The face of ' + character.name + ', matching the reference images exactly - same features, ' +
  'same face shape, same skin. ' + medium + '.';

const outPrefix = movie.slug + '/_face_fix/fix';
const seed = Math.floor(Math.random() * 2147483647);

const wf = {
  unet: { class_type: 'UNETLoader', inputs: { unet_name: 'flux-2-klein-9b.safetensors', weight_dtype: 'default' } },
  clip: { class_type: 'CLIPLoader', inputs: { clip_name: 'qwen_3_8b_fp8mixed.safetensors', type: 'flux2', device: 'default' } },
  vae: { class_type: 'VAELoader', inputs: { vae_name: 'flux2-vae.safetensors' } },
  srcimg: { class_type: 'LoadImage', inputs: { image: sourceRel } },
  samload: { class_type: 'SAMModelLoader (segment anything)', inputs: { model_name: 'sam_hq_vit_l (1.25GB)' } },
  dinoload: { class_type: 'GroundingDinoModelLoader (segment anything)', inputs: { model_name: 'GroundingDINO_SwinT_OGC (694MB)' } },
  // Threshold 0.3 matches the tuned pipeline. A miss leaves a near-empty mask,
  // which is a safe no-op - see the note about never inverting it.
  seg: {
    class_type: 'GroundingDinoSAMSegment (segment anything)',
    inputs: {
      sam_model: ['samload', 0],
      grounding_dino_model: ['dinoload', 0],
      image: ['srcimg', 0],
      prompt: parsed.maskPrompt || 'face',
      threshold: 0.3
    }
  },
  maskgrow: { class_type: 'GrowMask', inputs: { mask: ['seg', 1], expand: 10, tapered_corners: true } },
  srcvae: { class_type: 'VAEEncode', inputs: { pixels: ['srcimg', 0], vae: ['vae', 0] } },
  decode: { class_type: 'VAEDecode', inputs: { samples: ['sample', 0], vae: ['vae', 0] } },
  save: { class_type: 'SaveImage', inputs: { images: ['decode', 0], filename_prefix: outPrefix } }
};

// The LoRA, when the character has one, so the fix carries the same identity
// weights the rest of their references were made with.
let modelRef = ['unet', 0];
let clipRef = ['clip', 0];
if (character.lora_path) {
  wf.lora = {
    class_type: 'LoraLoader',
    inputs: {
      model: ['unet', 0],
      clip: ['clip', 0],
      lora_name: character.lora_path,
      strength_model: character.lora_strength_model,
      strength_clip: character.lora_strength_clip
    }
  };
  modelRef = ['lora', 0];
  clipRef = ['lora', 1];
}

wf.postxt = { class_type: 'CLIPTextEncode', inputs: { text: instruction, clip: clipRef } };
wf.negzero = { class_type: 'ConditioningZeroOut', inputs: { conditioning: ['postxt', 0] } };
// The source itself first, so the repaint stays consistent with the picture it
// is going back into, then the face references on top.
wf.srcref = { class_type: 'ReferenceLatent', inputs: { conditioning: ['postxt', 0], latent: ['srcvae', 0] } };
let posTip = ['srcref', 0];
refRels.forEach((rel, i) => {
  wf['ref' + i] = { class_type: 'LoadImage', inputs: { image: rel } };
  wf['refvae' + i] = { class_type: 'VAEEncode', inputs: { pixels: ['ref' + i, 0], vae: ['vae', 0] } };
  wf['reflat' + i] = { class_type: 'ReferenceLatent', inputs: { conditioning: posTip, latent: ['refvae' + i, 0] } };
  posTip = ['reflat' + i, 0];
});

wf.cond = {
  class_type: 'InpaintModelConditioning',
  inputs: {
    positive: posTip,
    negative: ['negzero', 0],
    vae: ['vae', 0],
    pixels: ['srcimg', 0],
    mask: ['maskgrow', 0],
    noise_mask: true
  }
};
wf.sample = {
  class_type: 'KSampler',
  inputs: {
    seed: seed,
    steps: Number(parsed.steps) || 4,
    cfg: 1,
    sampler_name: 'euler',
    scheduler: 'simple',
    denoise: 1,
    model: modelRef,
    positive: ['cond', 0],
    negative: ['cond', 1],
    latent_image: ['cond', 2]
  }
};

// ------------------------------------------------------------------ run it
const q = await axios.post(`${comfyUrl}/prompt`, { prompt: wf });
const promptId = q.data && q.data.prompt_id;
if (!promptId) return { error: 'ComfyUI rejected the graph: ' + JSON.stringify(q.data).slice(0, 400) };

let outRel = null;
for (let i = 0; i < 120; i++) {
  await new Promise((r) => setTimeout(r, 5000));
  const h = await axios.get(`${comfyUrl}/history/${promptId}`);
  const entry = h.data && h.data[promptId];
  if (!entry) continue;
  const st = entry.status || {};
  if (st.status_str === 'error') {
    return { action: 'error', reason: 'ComfyUI failed: ' + JSON.stringify(st.messages || '').slice(-500) };
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
if (!outRel) return { action: 'error', reason: 'Timed out waiting for the fix to render.' };

const imagePath = 'output/' + outRel;

// Filed as an edit, so it appears in the Edits group of every image picker and
// can be used as a first frame straight away.
const ins = await axios.post(
  `${insforgeUrl}/api/database/records/image_edits`,
  [
    {
      movie_id: movie.id,
      prompt: 'Face fix: ' + character.name,
      reference_paths: [relOf(parsed.imagePath)],
      reference_labels: ['source'],
      output_path: imagePath,
      width: 0,
      height: 0,
      steps: Number(parsed.steps) || 4,
      engine: 'face_fix',
      status: 'complete'
    }
  ],
  { headers: authHeaders }
);

return {
  action: 'complete',
  character: character.name,
  imagePath: imagePath,
  referencesUsed: refs.map((r) => r.kind),
  lora: character.lora_path || null,
  seed: seed,
  recorded: ins.status >= 200 && ins.status < 300,
  note:
    'Only the detected face was repainted; everything outside the mask is the original ' +
    'pixels. If the face is unchanged, the detector did not find one - that is deliberately ' +
    'a no-op rather than a full-frame rewrite.'
};
