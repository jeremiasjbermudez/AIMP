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
  params: { id: \`eq.\${shotId}\`, select: 'id,movie_id,act_number,scene_number,raw_capture_path' },
  headers: authHeaders
});
const shot = (shotRes.data || [])[0];
if (!shot) return { error: \`No shot found with id \${shotId}.\` };
if (!shot.raw_capture_path) return { error: \`Shot \${shotId} has no raw_capture_path - upload a camera-angle screenshot first.\` };

const panoRes = await axios.get(\`\${insforgeUrl}/api/database/records/scene_panos\`, {
  params: { movie_id: \`eq.\${shot.movie_id}\`, act_number: \`eq.\${shot.act_number}\`, scene_number: \`eq.\${shot.scene_number}\`, select: 'image_path' },
  headers: authHeaders
});
const pano = (panoRes.data || [])[0];
if (!pano) return { error: \`No panorama exists yet for A\${shot.act_number}S\${shot.scene_number}. Run 4-Panoramic-Generator for this scene first.\` };

const movieRes = await axios.get(\`\${insforgeUrl}/api/database/records/movies\`, {
  params: { id: \`eq.\${shot.movie_id}\`, select: 'bucket_name,slug' },
  headers: authHeaders
});
const movie = (movieRes.data || [])[0];
if (!movie) return { error: \`Movie \${shot.movie_id} not found.\` };

return {
  shotId,
  movieId: shot.movie_id,
  bucketName: movie.bucket_name,
  movieSlug: movie.slug,
  rawCapturePath: shot.raw_capture_path,
  panoImagePath: pano.image_path
};
`;

const node1 = `const resolved = JSON.parse($resolveOutput);
if (resolved.error) return { error: resolved.error };

const { shotId, bucketName, movieSlug, rawCapturePath, panoImagePath } = resolved;

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

function buildMultipart(fields) {
  const boundary = '----FlowiseShotUpload' + Math.random().toString(16).slice(2);
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

const key = encodeURIComponent(rawCapturePath);
const strategyRes = await axios.get(\`\${insforgeUrl}/api/storage/buckets/\${bucketName}/download-strategy/objects/\${key}\`, {
  headers: authHeaders
});
const strategy = strategyRes.data;
const fileHeaders = strategy.method === 'direct' ? authHeaders : {};
const fileRes = await axios.get(strategy.url, { headers: fileHeaders, responseType: 'arraybuffer' });
const rawBuf = Buffer.from(fileRes.data);

const stagedFilename = 'shot_' + shotId + '_raw.png';
const stagedSubfolder = movieSlug + '/_shots_raw';
const { body, boundary } = buildMultipart({
  type: 'input',
  subfolder: stagedSubfolder,
  overwrite: 'true',
  image: { data: rawBuf, filename: stagedFilename, contentType: 'image/png' }
});
const upRes = await axios.post(comfyUrl + '/upload/image', body, { headers: { 'Content-Type': \`multipart/form-data; boundary=\${boundary}\` } });
if (upRes.status < 200 || upRes.status >= 300) {
  await updateShot({ status: 'failed', error_message: 'Raw capture upload to ComfyUI failed: ' + JSON.stringify(upRes.data).slice(0, 300) });
  return { action: 'error', reason: 'Raw capture upload to ComfyUI failed.' };
}
const uglyPath = 'C:/ComfyUI2/input/' + stagedSubfolder + '/' + stagedFilename;
const cleanPath = 'C:/ComfyUI2/' + panoImagePath;
const tag = 'shot_' + shotId;

const g = {
  '1': { class_type: 'UNETLoader', inputs: { unet_name: 'qwen_image_edit_2511_bf16.safetensors', weight_dtype: 'default' } },
  '2': { class_type: 'CLIPLoader', inputs: { clip_name: 'qwen\\\\qwen_2.5_vl_7b.safetensors', type: 'qwen_image', device: 'default' } },
  '3': { class_type: 'VAELoader', inputs: { vae_name: 'qwen-image\\\\qwen_image_vae.safetensors' } },
  '4': { class_type: 'LoraLoaderModelOnly', inputs: { model: ['1', 0], lora_name: 'Sharp.safetensors', strength_model: 1 } },
  '5': { class_type: 'LoraLoaderModelOnly', inputs: { model: ['4', 0], lora_name: 'Qwen-Image-2512-Lightning-4steps-V1.0-fp32.safetensors', strength_model: 1 } },
  '6': { class_type: 'LoraLoaderModelOnly', inputs: { model: ['5', 0], lora_name: 'Qwen-Image-Edit-F2P.safetensors', strength_model: 0.65 } },
  '7': { class_type: 'ModelSamplingAuraFlow', inputs: { model: ['6', 0], shift: 3 } },
  '8': { class_type: 'CFGNorm', inputs: { model: ['7', 0], strength: 1, pre_cfg: false } },
  '9': { class_type: 'JWImageLoadRGB', inputs: { path: uglyPath } },
  '10': { class_type: 'JWImageLoadRGB', inputs: { path: cleanPath } },
  '11': { class_type: 'ImageScaleToTotalPixels', inputs: { image: ['9', 0], upscale_method: 'nearest-exact', megapixels: 1, resolution_steps: 1 } },
  '12': { class_type: 'ImageScaleToTotalPixels', inputs: { image: ['10', 0], upscale_method: 'lanczos', megapixels: 1, resolution_steps: 1 } },
  '13': { class_type: 'TextEncodeQwenImageEditPlus', inputs: {
    clip: ['2', 0], vae: ['3', 0], image1: ['11', 0], image2: ['12', 0],
    prompt: 'Using Gaussian Splatting, refer to the scene graph in Figure 2 to fix the perspective of the scene graph in Figure 1 and fill in the blank areas.'
  }},
  '14': { class_type: 'TextEncodeQwenImageEditPlus', inputs: {
    clip: ['2', 0], vae: ['3', 0], image1: ['11', 0], image2: ['12', 0], prompt: ''
  }},
  '15': { class_type: 'FluxKontextMultiReferenceLatentMethod', inputs: { conditioning: ['13', 0], reference_latents_method: 'index_timestep_zero' } },
  '16': { class_type: 'FluxKontextMultiReferenceLatentMethod', inputs: { conditioning: ['14', 0], reference_latents_method: 'index_timestep_zero' } },
  '17': { class_type: 'VAEEncode', inputs: { pixels: ['11', 0], vae: ['3', 0] } },
  '18': { class_type: 'KSampler', inputs: {
    model: ['8', 0], positive: ['15', 0], negative: ['16', 0], latent_image: ['17', 0],
    seed: Math.floor(Math.random() * 1e15), steps: 10, cfg: 1, sampler_name: 'euler', scheduler: 'simple', denoise: 1
  }},
  '19': { class_type: 'VAEDecode', inputs: { samples: ['18', 0], vae: ['3', 0] } },
  '20': { class_type: 'SaveImage', inputs: { images: ['19', 0], filename_prefix: movieSlug + '/_qwen_splat_cleanup/' + tag } }
};

const r = await axios.post(comfyUrl + '/prompt', { prompt: g });
const pid = r && r.data && r.data.prompt_id;
if (!pid) {
  const msg = 'Qwen cleanup enqueue failed: ' + JSON.stringify((r && r.data && r.data.node_errors) || (r && r.data)).slice(0, 1000);
  await updateShot({ status: 'failed', error_message: msg });
  return { action: 'error', reason: msg };
}

const rec = await waitFor(pid, 150, 5000);
if (!rec) {
  return { action: 'pending', reason: 'Qwen cleanup still running past the check window.', promptId: pid };
}
if (rec.status.status_str === 'error') {
  const msg = 'Qwen cleanup failed in ComfyUI: ' + JSON.stringify(rec.status.messages).slice(0, 1000);
  await updateShot({ status: 'failed', error_message: msg });
  return { action: 'error', reason: msg };
}

let outRel = null;
const outputs = rec.outputs || {};
for (const nid in outputs) {
  if (outputs[nid].images && outputs[nid].images[0]) {
    const f = outputs[nid].images[0];
    outRel = (f.subfolder ? f.subfolder + '/' : '') + f.filename;
  }
}
if (!outRel) {
  const msg = 'Qwen cleanup produced no output image.';
  await updateShot({ status: 'failed', error_message: msg });
  return { action: 'error', reason: msg };
}

const cleanedImagePath = 'output/' + outRel;
await updateShot({ status: 'cleaned', cleaned_image_path: cleanedImagePath, error_message: null });

return { action: 'cleaned', shotId, cleanedImagePath, promptId: pid };
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

  const n0 = fnNode('customFunctionAgentflow_0', 'Resolve Shot', 300, node0, [
    { variableName: 'insforgeUrl', variableValue: INSFORGE_URL },
    { variableName: 'insforgeApiKey', variableValue: INSFORGE_API_KEY }
  ], FN_INPUTS);

  const n1 = fnNode('customFunctionAgentflow_1', 'Run Qwen Cleanup', 700, node1, [
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

  try {
    const res = await axios.post(
      BASE + '/api/v1/chatflows',
      { name: '6-GS-Cleaner', type: 'AGENTFLOW', flowData: JSON.stringify(flowData), deployed: true },
      { headers: { Authorization: 'Bearer ' + API_KEY } }
    );
    console.log('CREATED', res.data.id);
  } catch (e) {
    console.log('CREATE FAILED', e.response ? JSON.stringify(e.response.data).slice(0, 2000) : e.message);
  }
})();
