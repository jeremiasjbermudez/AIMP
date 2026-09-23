// Pick model files by what this ComfyUI actually has.
//
// Included with `// @include comfy_models`. A graph used to name one exact
// file - 'qwen_image_edit_2511_bf16.safetensors', 'qwen-image\qwen_image_vae' -
// and a render host holding the same model in another precision or folder
// rejected the job outright. A graph now lists what it would accept, best
// first, and gets the first one this ComfyUI has, spelled the way ComfyUI
// lists it.

// One listing per folder per run: a graph asking for five files in one folder
// should not ask ComfyUI five times.
const _comfyModelLists = {};

async function comfyModelList(folder) {
  if (!_comfyModelLists[folder]) {
    const axios = require('axios');
    const res = await axios.get(String($comfyUrl).replace(/\/$/, '') + '/models/' + folder, { timeout: 15000 });
    _comfyModelLists[folder] = Array.isArray(res.data) ? res.data : [];
  }
  return _comfyModelLists[folder];
}

// The same file, whichever slash it is written with and whichever subfolder
// it sits in: 'qwen-image\qwen_image_vae.safetensors' is the same VAE as a
// 'qwen_image_vae.safetensors' kept at the top of models/vae.
function sameModelFile(have, want) {
  const norm = (s) => String(s).replace(/\\/g, '/').toLowerCase();
  const h = norm(have);
  const w = norm(want);
  return h === w || h.split('/').pop() === w.split('/').pop();
}

/**
 * The first of `candidates` that ComfyUI has in models/<folder>.
 * With { optional: true } a miss returns null (for a LoRA a graph can do
 * without); otherwise it throws, naming what was looked for.
 */
async function pickModel(folder, candidates, opts) {
  const list = await comfyModelList(folder);
  for (const want of candidates) {
    const hit = list.find((have) => sameModelFile(have, want));
    if (hit) return hit;
  }
  if (opts && opts.optional) return null;
  throw new Error(
    'ComfyUI has none of these in models/' + folder + ': ' + candidates.join(', ') +
    '. Run fetch-assets for this module on the ComfyUI machine.'
  );
}
