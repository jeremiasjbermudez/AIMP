// @include comfy_paths

const resolved = JSON.parse($resolveOutput);
if (resolved.error) return { error: resolved.error };

const { movieId, movieSlug, act, sceneNumber, seed, force, preset } = resolved;

const axios = require('axios');
const insforgeUrl = $insforgeUrl;
const insforgeApiKey = $insforgeApiKey;
const comfyUrl = $comfyUrl;
const authHeaders = { Authorization: `Bearer ${insforgeApiKey}` };
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

const outputSubfolder = movieSlug + '/_pano';
const stagedRel = movieSlug + '/panos/scene' + sceneNumber + '.png';
const stagedFilename = 'scene' + sceneNumber + '.png';
const stagedSubfolder = movieSlug + '/panos';

async function upsertPano(patch) {
  const existingRes = await axios.get(`${insforgeUrl}/api/database/records/scene_panos`, {
    params: { movie_id: `eq.${movieId}`, act_number: `eq.${act}`, scene_number: `eq.${sceneNumber}`, select: 'id' },
    headers: authHeaders
  });
  const existing = (existingRes.data || [])[0];
  if (existing) {
    await axios.patch(`${insforgeUrl}/api/database/records/scene_panos`, patch, {
      params: { id: `eq.${existing.id}` },
      headers: { ...authHeaders, 'Content-Type': 'application/json', Prefer: 'return=minimal' }
    });
  } else {
    await axios.post(`${insforgeUrl}/api/database/records/scene_panos`, { movie_id: movieId, act_number: act, scene_number: sceneNumber, ...patch }, {
      headers: { ...authHeaders, 'Content-Type': 'application/json', Prefer: 'return=minimal' }
    });
  }
}

function buildMultipart(fields) {
  const boundary = '----FlowisePanoUpload' + Math.random().toString(16).slice(2);
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

const uploadedPano = ($flow.uploads || []).find((u) => u && u.mime && u.mime.indexOf('image/') === 0 && u.data);
if (uploadedPano) {
  const b64 = uploadedPano.data.includes(',') ? uploadedPano.data.split(',')[1] : uploadedPano.data;
  const buf = Buffer.from(b64, 'base64');
  const { body, boundary } = buildMultipart({
    type: 'input',
    subfolder: stagedSubfolder,
    overwrite: 'true',
    image: { data: buf, filename: stagedFilename, contentType: uploadedPano.mime }
  });
  const upRes = await axios.post(comfyUrl + '/upload/image', body, { headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` } });
  if (upRes.status < 200 || upRes.status >= 300) {
    return { action: 'error', reason: 'Custom pano upload to ComfyUI failed: ' + JSON.stringify(upRes.data).slice(0, 300) };
  }
  await upsertPano({ image_path: 'input/' + stagedRel, seed: null, source: 'manual_upload', location_derivation: null, room_prose: null });
  return { action: 'manual_upload', sceneNumber, act, imagePath: 'input/' + stagedRel, uploadedName: uploadedPano.name };
}

if (!force) {
  const existingRes = await axios.get(`${insforgeUrl}/api/database/records/scene_panos`, {
    params: { movie_id: `eq.${movieId}`, act_number: `eq.${act}`, scene_number: `eq.${sceneNumber}`, select: 'id,image_path' },
    headers: authHeaders
  });
  const existing = (existingRes.data || [])[0];
  if (existing) {
    return { action: 'skipped', reason: 'pano already exists for this scene - use --force to regenerate', sceneNumber, act, imagePath: existing.image_path };
  }
}

// Room description now comes directly from the scenes table - dedicated,
// clean location fields (no character narrative mixed in), so no LLM
// extraction pass is needed the way beat-derived text required.
const sceneRes = await axios.get(`${insforgeUrl}/api/database/records/scenes`, {
  params: { movie_id: `eq.${movieId}`, act_number: `eq.${act}`, scene_number: `eq.${sceneNumber}`, select: '*', limit: 1 },
  headers: authHeaders
});
const scene = (sceneRes.data || [])[0];
if (!scene) {
  return { action: 'error', reason: `No scene row found for A${act}S${sceneNumber} in the scenes table. Add it first.` };
}

let room = '';
let derivationSrc = '';
if (scene.location_description) {
  room = [scene.scene_heading, scene.location_description, scene.atmosphere, scene.set_dressing]
    .filter(Boolean).join('. ').replace(/\s+/g, ' ').trim().slice(0, 900);
  derivationSrc = 'scenes.location_description (+ atmosphere/set_dressing)';
} else if (scene.scene_heading) {
  // Fallback to book RAG if the scene row exists but has no location detail yet.
  try {
    const queryText = [scene.scene_heading, scene.location_name, scene.int_ext].filter(Boolean).join(' ') || `scene ${sceneNumber} location description`;
    const ragRes = await axios.post(`${insforgeUrl}/functions/book-rag-search`, { movieId, queryText, matchCount: 20, matchThreshold: 0.1 }, { headers: { ...authHeaders, 'Content-Type': 'application/json' } });
    const matches = (ragRes.data && ragRes.data.matches) || [];
    if (matches.length > 0) {
      room = [scene.scene_heading, matches.map((m) => m.content).join(' ')].filter(Boolean).join('. ').replace(/\s+/g, ' ').trim().slice(0, 900);
      derivationSrc = 'book RAG fallback (scenes row had no location_description)';
    } else {
      room = scene.scene_heading.replace(/\d+/g, '').trim();
      derivationSrc = 'scene heading only (no location_description, no book match)';
    }
  } catch (e) {
    room = scene.scene_heading.replace(/\d+/g, '').trim();
    derivationSrc = 'scene heading only (book RAG failed)';
  }
}
if (!room) {
  return { action: 'error', reason: `Could not derive any room description for A${act}S${sceneNumber} - scenes row has no location_description or scene_heading.` };
}

const COZY_RE = /\b(compact|cozy|cosy|cramped|intimate|snug)\b/i;
const isCozy = COZY_RE.test(room);
const EMPTY_ROOM_CLAUSE = 'empty room, no people, unoccupied, nobody present, vacant';

// The scene's look, instead of "photorealistic, cinematic" hard-coded into every
// branch. A photoreal backplate in an anime film fights every character
// composited onto it - the same failure as the first prop sheet, which came back
// as a photograph. Tag form rather than the sentence form the frame prompts use,
// because this prompt is a comma-separated tag list.
const STYLE_TAGS = {
  anime: '2D cel-shaded anime background art, clean line art, vibrant colors',
  cartoon: '2D cartoon background, bold outlines, flat vivid colors',
  animated: '3D animated film background, stylized, soft cinematic lighting',
  photographic: 'photorealistic, cinematic'
};
const styleTag = STYLE_TAGS[scene.render_style] || STYLE_TAGS.photographic;

let prompt;
if (isCozy) {
  prompt = 'equirectangular 360 degree panorama, ' + room + ', ' + EMPTY_ROOM_CLAUSE + ', ' + styleTag;
} else {
  const roomWithDistance = room.replace(/\b(walls?|fireplace|bookshelf|bookshelves|windows?)\b/gi, 'distant $1');
  prompt = 'equirectangular 360 degree panorama, camera placed perfectly in the center of a spacious room, ' + roomWithDistance + ', significant open floor space surrounding the camera, ' + EMPTY_ROOM_CLAUSE + ', ' + styleTag;
}

// A hand-written prompt overrides the one derived from the scene prose.
// Passed as --prompt "..." on the raw input, so the upstream scene resolver
// keeps working unchanged - it only cares about the A1S3 scope and --force.
//
// The unoccupied clause is still appended: a panorama with a person baked into
// it cannot be used as a plate, and that is a pipeline requirement rather than
// a stylistic preference.
const rawFlowInput = (String($flow.input || '').replace(/--movie\s+\S+/gi, '')).toString();
const manualPrompt = (rawFlowInput.match(/--prompt\s+"([\s\S]+?)"/i) || [])[1];
if (manualPrompt && manualPrompt.trim()) {
  prompt = manualPrompt.trim().replace(/[,\s]+$/, '') + ', ' + EMPTY_ROOM_CLAUSE + ', ' + styleTag;
}

const outputPresetHeight = parseInt((preset.split(/\s*x\s*/i)[1]) || '1024', 10);
const state = JSON.stringify({ version: 1, projection_model: 'pinhole_rectilinear', alpha_mode: 'straight', bg_color: '#00ff00', output_preset: outputPresetHeight, assets: {}, stickers: [] });

// PanoramaStickers 1.5 takes the ERP width alone ('1024' / '2048' / '4096')
// where it used to take '2048 x 1024', and requires coverage and fps. fps
// only drives the node's own preview.
const stickersPreset = ['1024', '2048', '4096'].indexOf(String(parseInt(preset, 10))) >= 0
  ? String(parseInt(preset, 10)) : '2048';

const g = {
  48: { class_type: 'UNETLoader', inputs: { unet_name: 'flux-2-klein-9b.safetensors', weight_dtype: 'default' } },
  44: { class_type: 'CLIPLoader', inputs: { clip_name: 'qwen_3_8b_fp8mixed.safetensors', type: 'flux2', device: 'default' } },
  43: { class_type: 'VAELoader', inputs: { vae_name: 'flux2-vae.safetensors' } },
  63: { class_type: 'LoraLoaderModelOnly', inputs: { model: ['48', 0], lora_name: 'flux-2-klein-9B-360-erp-outpaint-lora_V1.safetensors', strength_model: 0.9 } },
  56: { class_type: 'PanoramaStickers', inputs: { output_preset: stickersPreset, coverage: '360', fps: 24, bg_color: '#00ff00', state_json: state } },
  52: { class_type: 'VAEEncode', inputs: { pixels: ['56', 0], vae: ['43', 0] } },
  6: { class_type: 'CLIPTextEncode', inputs: { clip: ['44', 0], text: prompt } },
  33: { class_type: 'CLIPTextEncode', inputs: { clip: ['44', 0], text: 'text, worst quality, blurry, ugly, people, person, human, man, woman, figure, character, crowd, staff, occupants' } },
  49: { class_type: 'ReferenceLatent', inputs: { conditioning: ['6', 0], latent: ['52', 0] } },
  55: { class_type: 'ReferenceLatent', inputs: { conditioning: ['33', 0], latent: ['52', 0] } },
  31: { class_type: 'KSampler', inputs: { model: ['63', 0], positive: ['49', 0], negative: ['55', 0], latent_image: ['52', 0], seed, steps: 20, cfg: 5, sampler_name: 'euler', scheduler: 'simple', denoise: 1 } },
  8: { class_type: 'VAEDecode', inputs: { samples: ['31', 0], vae: ['43', 0] } },
  66: { class_type: 'SaveImage', inputs: { images: ['8', 0], filename_prefix: outputSubfolder + '/scene' + sceneNumber + '_pano' } },
  98: { class_type: 'JWImageSaveToPath', inputs: { image: ['8', 0], path: String($comfyRoot || 'C:/ComfyUI2').replace(/[\\/]+$/, '') + '/input/' + stagedRel, overwrite: 'true' } }
};

await axios.post(comfyUrl + '/free', { unload_models: true, free_memory: true });
ensureSaveDirs(g);
const submitRes = await axios.post(comfyUrl + '/prompt', { prompt: g });
const promptId = submitRes.data && submitRes.data.prompt_id;
// ComfyUI puts a missing node type or model in .error, not in .node_errors,
// so reporting only node_errors printed {} for the commonest failure.
if (!promptId) return { action: 'error', reason: 'Pano enqueue failed: ' + JSON.stringify({ error: submitRes.data && submitRes.data.error, node_errors: submitRes.data && submitRes.data.node_errors }).slice(0, 700) };

let outRel = null;
let renderError = null;
for (let i = 0; i < 90; i++) {
  await sleep(5000);
  try {
    const h = await axios.get(comfyUrl + '/history/' + promptId);
    const rec = h.data && h.data[promptId];
    if (rec && rec.status && (rec.status.completed || rec.status.status_str)) {
      if (rec.status.status_str === 'error') {
        renderError = JSON.stringify(rec.status.messages).slice(0, 500);
        break;
      }
      const outputs = rec.outputs || {};
      for (const nodeId in outputs) {
        if (outputs[nodeId].images && outputs[nodeId].images[0]) {
          const f = outputs[nodeId].images[0];
          outRel = (f.subfolder ? f.subfolder + '/' : '') + f.filename;
        }
      }
      break;
    }
  } catch (e) {}
}
if (renderError) return { action: 'error', reason: 'Pano render failed in ComfyUI: ' + renderError };
if (!outRel) return { action: 'pending', reason: 'Still rendering past the poll window', promptId };

await upsertPano({ image_path: 'input/' + stagedRel, seed, source: 'generated', location_derivation: derivationSrc, room_prose: room });

// The prompt library. scene_panos keeps the picture and the seed but has never
// kept the words, so a deleted panorama could not be made again - and a panorama
// is upstream of the splat and of every plate built from it, so losing one loses
// the room. Logged after the render lands: a prompt that produced nothing is not
// one you would rebuild from.
try {
  await axios.post(
    `${insforgeUrl}/api/database/records/prompt_log`,
    [
      {
        movie_id: movieId,
        kind: 'panorama',
        source: '5-Panoramic-Generator',
        subject_table: 'scene_panos',
        scene_number: sceneNumber,
        prompt,
        settings: { seed, act, steps: 20, cfg: 5, sampler: 'euler', scheduler: 'simple' },
        output_path: 'input/' + stagedRel,
        comfy_prompt_id: promptId
      }
    ],
    { headers: { ...authHeaders, 'Content-Type': 'application/json' }, validateStatus: () => true }
  );
} catch (e) {
  // Never fails the render.
}

return {
  action: 'generated',
  sceneNumber,
  act,
  imagePath: 'input/' + stagedRel,
  outputPath: 'output/' + outRel,
  seed,
  locationDerivation: derivationSrc,
  roomProse: room.slice(0, 300),
  promptId
};
