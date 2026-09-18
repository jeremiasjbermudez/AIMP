const axios = require('axios');
const BASE = 'http://localhost:3010';
const API_KEY = '<REDACTED>';
const INSFORGE_URL = 'http://localhost:7130';
const INSFORGE_API_KEY = '<INSFORGE_API_KEY>';
const COMFY_URL = 'http://127.0.0.1:8188';

const node0 = `const rawInput = ($flow.input || '').toString();
let parsed;
try { parsed = JSON.parse(rawInput); } catch (e) {
  return { error: 'Expected JSON input {"shotId": "<uuid>"}, got: ' + rawInput };
}
const shotId = parsed.shotId;
if (!shotId) return { error: 'Missing shotId in input.' };

const axios = require('axios');
const insforgeUrl = $insforgeUrl;
const insforgeApiKey = $insforgeApiKey;
const authHeaders = { Authorization: \`Bearer \${insforgeApiKey}\` };

const shotRes = await axios.get(\`\${insforgeUrl}/api/database/records/shots\`, {
  params: { id: \`eq.\${shotId}\`, select: 'id,movie_id,cleaned_image_path,prompt_text,reference_character_image_ids,status,length_frames' },
  headers: authHeaders
});
const shot = (shotRes.data || [])[0];
if (!shot) return { error: \`No shot found with id \${shotId}.\` };
if (!shot.cleaned_image_path) return { error: \`Shot \${shotId} has no cleaned_image_path yet - run 6-GS-Cleaner first.\` };
if (!shot.prompt_text || !shot.prompt_text.trim()) return { error: \`Shot \${shotId} has no prompt_text - write/save a prompt before submitting for video.\` };

const movieRes = await axios.get(\`\${insforgeUrl}/api/database/records/movies\`, {
  params: { id: \`eq.\${shot.movie_id}\`, select: 'slug' },
  headers: authHeaders
});
const movie = (movieRes.data || [])[0];
if (!movie) return { error: \`Movie \${shot.movie_id} not found.\` };

const refIds = Array.isArray(shot.reference_character_image_ids) ? shot.reference_character_image_ids : [];
const referenceImagePaths = [];
for (const refId of refIds) {
  const ciRes = await axios.get(\`\${insforgeUrl}/api/database/records/character_images\`, {
    params: { id: \`eq.\${refId}\`, select: 'image_path' },
    headers: authHeaders
  });
  const ci = (ciRes.data || [])[0];
  if (!ci) return { error: \`character_images row \${refId} referenced by shot \${shotId} no longer exists.\` };
  referenceImagePaths.push(ci.image_path);
}

return {
  shotId,
  movieSlug: movie.slug,
  cleanedImagePath: shot.cleaned_image_path,
  referenceImagePaths,
  promptText: shot.prompt_text,
  lengthFrames: shot.length_frames
};
`;

const node1 = `const resolved = JSON.parse($resolveOutput);
if (resolved.error) return { error: resolved.error };

const { shotId, movieSlug, cleanedImagePath, referenceImagePaths, promptText, lengthFrames } = resolved;

const axios = require('axios');
const insforgeUrl = $insforgeUrl;
const insforgeApiKey = $insforgeApiKey;
const comfyUrl = $comfyUrl;
const authHeaders = { Authorization: \`Bearer \${insforgeApiKey}\` };
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

async function updateShot(patch) {
  await axios.patch(\`\${insforgeUrl}/api/database/records/shots\`, patch, {
    params: { id: \`eq.\${shotId}\` },
    headers: { ...authHeaders, 'Content-Type': 'application/json', Prefer: 'return=minimal' }
  });
}

await updateShot({ status: 'rendering', error_message: null });

const waitFor = async (pid, maxTries, everyMs) => {
  for (let k = 0; k < maxTries; k++) {
    await sleep(everyMs);
    try {
      const h = await axios.get(comfyUrl + '/history/' + pid);
      const rec = h && h.data && h.data[pid];
      if (rec && rec.status && rec.status.status_str) return rec;
    } catch (e) {}
  }
  return null;
};

// Duration (seconds) -> frame length on MiniMax H3's 17k+5 grid. Exact same
// formula the official template's own ComfyMathExpression node uses.
// The admin UI estimates this from the beat's dialogue and stores it already
// snapped to the 17k+5 grid, so the flow just honours it. The 124-frame
// fallback (the official template's 5s default) covers rows created before
// length_frames existed, and anything the UI left unset.
const length = Number(lengthFrames) > 0 ? Number(lengthFrames) : 124;

// Matches the official template's own ResolutionSelector default (16:9
// Widescreen, 0.4 megapixels, multiple 32) exactly.
const width = 864;
const height = 480;

function buildMultipart(fields) {
  const boundary = '----FlowiseMiniMaxStage' + Math.random().toString(16).slice(2);
  const parts = [];
  for (const [name, value] of Object.entries(fields)) {
    if (Buffer.isBuffer(value.data)) {
      parts.push(Buffer.from(\`--\${boundary}\\r\\nContent-Disposition: form-data; name="\${name}"; filename="\${value.filename}"\\r\\nContent-Type: \${value.contentType}\\r\\n\\r\\n\`));
      parts.push(value.data);
      parts.push(Buffer.from('\\r\\n'));
    } else {
      parts.push(Buffer.from(\`--\${boundary}\\r\\nContent-Disposition: form-data; name="\${name}"\\r\\n\\r\\n\${value}\\r\\n\`));
    }
  }
  parts.push(Buffer.from(\`--\${boundary}--\\r\\n\`));
  return { body: Buffer.concat(parts), boundary };
}

// The official template's two reference-image nodes are plain LoadImage,
// which reads by filename from ComfyUI's input/ folder - not JWImageLoadRGB
// with an absolute path (an earlier version of this file used JWImageLoadRGB
// throughout, a real structural difference from the proven graph). Character
// reference images already live under input/, so they can be used as-is;
// the cleaned camera-angle image lives under output/ (Qwen cleanup's
// SaveImage), so it needs staging into input/ first via ComfyUI's own
// /upload/image - done as its own submission, since a single /prompt graph
// has no way to force a copy step to run before a plain LoadImage node
// (LoadImage takes no input link, so nothing would order them correctly).
async function stageIntoInput(absOutputPath, stagedRelPath) {
  const parts = absOutputPath.replace(/\\\\/g, '/').split('/output/');
  const readRes = await axios.get(comfyUrl + '/view', {
    params: { filename: parts[1].split('/').pop(), subfolder: parts[1].split('/').slice(0, -1).join('/'), type: 'output' },
    responseType: 'arraybuffer'
  });
  const relParts = stagedRelPath.split('/');
  const stagedFilename = relParts.pop();
  const stagedSubfolder = relParts.join('/');
  const { body, boundary } = buildMultipart({
    type: 'input', subfolder: stagedSubfolder, overwrite: 'true',
    image: { data: Buffer.from(readRes.data), filename: stagedFilename, contentType: 'image/png' }
  });
  const upRes = await axios.post(comfyUrl + '/upload/image', body, { headers: { 'Content-Type': \`multipart/form-data; boundary=\${boundary}\` } });
  if (upRes.status < 200 || upRes.status >= 300) throw new Error('Staging cleaned image into input/ failed: ' + JSON.stringify(upRes.data).slice(0, 300));
  return stagedRelPath;
}

const cleanedStagedRel = movieSlug + '/_minimax_clips/staged/shot_' + shotId + '_picture1.png';
await stageIntoInput('C:/ComfyUI2/' + cleanedImagePath, cleanedStagedRel);

// ref_images[0] = the cleaned camera-angle/background render (Picture 1),
// then each selected character reference in order (Picture 2, 3, ...).
// Filenames relative to input/, matching plain LoadImage's own convention -
// character_images.image_path is already stored as "input/...".
const allRefRelPaths = [cleanedStagedRel, ...referenceImagePaths.map((p) => p.replace(/^input\\//, ''))];
if (allRefRelPaths.length > 9) allRefRelPaths.length = 9;

// Node-for-node translation of the actual official R2V template
// (minimax_h3_r2v.json, id e3f2b845-8f2c-4b5a-9caf-eac1029d3e7e, shipped
// locally in ComfyUI's own workflows folder and confirmed working as-is by
// direct manual test) - not an approximation from documentation. Kept
// identical on every setting that isn't inherently per-shot data: sampler
// res_multistep, scheduler simple, 20 steps (turbo LoRA off, matching the
// template's own default), no SigmaShift (not present in the official
// graph), ref_image_size "match" (not "max" - an earlier version of this
// file changed this without it being part of the proven template), LoadImage
// (not JWImageLoadRGB) for references, CreateVideo+SaveVideo (not
// VHS_VideoCombine) for output.
const g = {
  '119': { class_type: 'VAELoader', inputs: { vae_name: 'minimax_h3_video_vae_fp16.safetensors' } },
  '120': { class_type: 'VAELoader', inputs: { vae_name: 'minimax_h3_audio_vae_fp32.safetensors' } },
  '127': { class_type: 'UNETLoader', inputs: { unet_name: 'minimax_h3_ref2va_pruned_int8_convrot.safetensors', weight_dtype: 'default' } },
  '128': { class_type: 'CLIPLoader', inputs: { clip_name: 'qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors', type: 'minimax', device: 'default' } },
  '129': { class_type: 'RandomNoise', inputs: { noise_seed: Math.floor(Math.random() * 1e15) } },
  '123': { class_type: 'KSamplerSelect', inputs: { sampler_name: 'res_multistep' } },
  '124': { class_type: 'BasicScheduler', inputs: { model: ['127', 0], scheduler: 'simple', steps: 20, denoise: 1 } },
  '126': { class_type: 'BasicGuider', inputs: { model: ['127', 0], conditioning: ['136', 0] } },
  '125': { class_type: 'SamplerCustomAdvanced', inputs: { noise: ['129', 0], guider: ['126', 0], sampler: ['123', 0], sigmas: ['124', 0], latent_image: ['136', 1] } },
  '122': { class_type: 'VAEDecode', inputs: { samples: ['125', 0], vae: ['119', 0] } },
  '121': { class_type: 'VAEDecodeAudio', inputs: { samples: ['125', 0], vae: ['120', 0] } },
  '130': { class_type: 'CreateVideo', inputs: { images: ['122', 0], audio: ['121', 0], fps: 24, bit_depth: 8 } },
  '92': { class_type: 'SaveVideo', inputs: { video: ['130', 0], filename_prefix: movieSlug + '/_minimax_clips/shot_' + shotId, format: 'auto', codec: 'auto' } }
};

const refImageInputs = {};
allRefRelPaths.forEach((relPath, i) => {
  const nodeId = 'ref_' + i;
  g[nodeId] = { class_type: 'LoadImage', inputs: { image: relPath } };
  // ref_images is COMFY_AUTOGROW_V3. In /prompt API format its slots are
  // addressed by flat dotted keys on the node's own inputs - a nested
  // { ref_image_0: [...] } object is read as a plain value, so the link is
  // never made and the LoadImage nodes sit unconnected.
  refImageInputs['ref_images.ref_image_' + i] = [nodeId, 0];
});

g['136'] = {
  class_type: 'MiniMaxH3ReferenceToVideo',
  inputs: {
    clip: ['128', 0],
    vae: ['119', 0],
    audio_vae: ['120', 0],
    prompt: promptText,
    width, height, length,
    ref_image_size: 'match',
    ...refImageInputs
  }
};

const r = await axios.post(comfyUrl + '/prompt', { prompt: g });
const pid = r && r.data && r.data.prompt_id;
if (!pid) {
  const msg = 'MiniMax enqueue failed: ' + JSON.stringify((r && r.data && r.data.node_errors) || (r && r.data)).slice(0, 1500);
  await updateShot({ status: 'failed', error_message: msg });
  return { action: 'error', reason: msg };
}

// Untested pipeline (first-ever run of MiniMaxH3ReferenceToVideo here) - generous poll window.
const rec = await waitFor(pid, 240, 10000);
if (!rec) {
  return { action: 'pending', reason: 'MiniMax generation still running past the check window.', promptId: pid };
}
if (rec.status.status_str === 'error') {
  const msg = 'MiniMax generation failed in ComfyUI: ' + JSON.stringify(rec.status.messages).slice(0, 1500);
  await updateShot({ status: 'failed', error_message: msg });
  return { action: 'error', reason: msg };
}

let outRel = null;
const outputs = rec.outputs || {};
for (const nid in outputs) {
  const o = outputs[nid];
  // SaveVideo (the official template's own output node) writes under
  // "images", confirmed against a real completed history entry - not
  // "gifs"/"videos" as VHS_VideoCombine (the node this file used before) does.
  const candidates = o.images || o.gifs || o.videos || [];
  if (candidates[0]) {
    const f = candidates[0];
    outRel = (f.subfolder ? f.subfolder + '/' : '') + f.filename;
  }
}
if (!outRel) {
  const msg = 'MiniMax generation produced no output video (raw outputs: ' + JSON.stringify(outputs).slice(0, 800) + ')';
  await updateShot({ status: 'failed', error_message: msg });
  return { action: 'error', reason: msg };
}

const videoPath = 'output/' + outRel;
await updateShot({ status: 'complete', video_path: videoPath, error_message: null });

return { action: 'complete', shotId, videoPath, promptId: pid };
`;

function fnNode(id, label, x, code, inputVariables, inputParams) {
  return {
    id, position: { x, y: 0 }, type: 'agentFlow',
    data: {
      id, label, version: 1.1, name: 'customFunctionAgentflow', type: 'CustomFunction',
      color: '#E4B7FF', baseClasses: ['CustomFunction'], category: 'Agent Flows',
      description: 'Execute custom function', inputParams, inputAnchors: [],
      inputs: { customFunctionInputVariables: inputVariables, customFunctionJavascriptFunction: code },
      outputAnchors: [], outputs: {}, selected: false
    },
    width: 300, height: 100, selected: false, positionAbsolute: { x, y: 0 }, dragging: false
  };
}

function edge(source, target) {
  return {
    source, sourceHandle: source + '-output-customFunction',
    target, targetHandle: target + '-input-customFunction',
    type: 'agentFlow', id: source + '-' + target
  };
}

(async () => {
  const fnSchema = await axios.get(BASE + '/api/v1/nodes/customFunctionAgentflow', { headers: { Authorization: 'Bearer ' + API_KEY } });
  const FN_INPUTS = fnSchema.data.inputs;
  const startSchema = await axios.get(BASE + '/api/v1/nodes/startAgentflow', { headers: { Authorization: 'Bearer ' + API_KEY } });

  const startNode = {
    id: 'startAgentflow_0', position: { x: 0, y: 0 }, type: 'agentFlow',
    data: {
      id: 'startAgentflow_0', label: 'Start', version: 1.4, name: 'startAgentflow', type: 'Start',
      color: '#7EE787', hideInput: true, baseClasses: ['Start'], category: 'Agent Flows',
      description: 'Starting point of the agentflow', inputParams: startSchema.data.inputs, inputAnchors: [],
      inputs: { startInputType: 'chatInput' }, outputAnchors: [], outputs: {}, selected: false
    },
    width: 300, height: 100, selected: false, positionAbsolute: { x: 0, y: 0 }, dragging: false
  };

  const n0 = fnNode('customFunctionAgentflow_0', 'Resolve Shot & References', 300, node0, [
    { variableName: 'insforgeUrl', variableValue: INSFORGE_URL },
    { variableName: 'insforgeApiKey', variableValue: INSFORGE_API_KEY }
  ], FN_INPUTS);

  const n1 = fnNode('customFunctionAgentflow_1', 'Generate MiniMax Clip', 700, node1, [
    { variableName: 'resolveOutput', variableValue: '{{ customFunctionAgentflow_0.output.content }}' },
    { variableName: 'insforgeUrl', variableValue: INSFORGE_URL },
    { variableName: 'insforgeApiKey', variableValue: INSFORGE_API_KEY },
    { variableName: 'comfyUrl', variableValue: COMFY_URL }
  ], FN_INPUTS);

  const flowData = {
    nodes: [startNode, n0, n1],
    edges: [
      { source: 'startAgentflow_0', sourceHandle: 'startAgentflow_0-output-startAgentflow', target: 'customFunctionAgentflow_0', targetHandle: 'customFunctionAgentflow_0-input-customFunction', type: 'agentFlow', id: 'startAgentflow_0-customFunctionAgentflow_0' },
      edge('customFunctionAgentflow_0', 'customFunctionAgentflow_1')
    ],
    viewport: { x: 0, y: 0, zoom: 0.6 }
  };

  const EXISTING_ID = process.env.UPDATE_ID;
  try {
    if (EXISTING_ID) {
      const res = await axios.put(
        BASE + '/api/v1/chatflows/' + EXISTING_ID,
        { flowData: JSON.stringify(flowData) },
        { headers: { Authorization: 'Bearer ' + API_KEY } }
      );
      console.log('UPDATED', res.data.id);
    } else {
      const res = await axios.post(
        BASE + '/api/v1/chatflows',
        { name: '7-MiniMax-Clip-Generator', type: 'AGENTFLOW', flowData: JSON.stringify(flowData), deployed: true },
        { headers: { Authorization: 'Bearer ' + API_KEY } }
      );
      console.log('CREATED', res.data.id);
    }
  } catch (e) {
    console.log('CREATE/UPDATE FAILED', e.response ? JSON.stringify(e.response.data).slice(0, 2000) : e.message);
  }
})();
