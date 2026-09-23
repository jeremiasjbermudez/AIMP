const resolved = JSON.parse($resolveOutput);
if (resolved.error) return { error: resolved.error };

const { movieId, movieSlug, bucketName, characterId, characterName, requestedType, force } = resolved;

const axios = require('axios');
const insforgeUrl = $insforgeUrl;
const insforgeApiKey = $insforgeApiKey;
const comfyUrl = $comfyUrl;
const ollamaBaseUrl = $ollamaBaseUrl;
const ollamaModel = $ollamaModel;
const authHeaders = { Authorization: `Bearer ${insforgeApiKey}` };

const charRes = await axios.get(`${insforgeUrl}/api/database/records/characters`, {
  params: { id: `eq.${characterId}`, select: '*' },
  headers: authHeaders
});
const character = (charRes.data || [])[0];
if (!character || !character.visual_anchor) {
  return { action: 'skipped', reason: 'no visual_anchor resolved for this character yet - run descriptor generation first', characterId, characterName };
}

const gender = character.gender || 'person';
const clothing = character.clothing || null;
const visualAnchor = character.visual_anchor;
const lora = character.lora_path || null;
const loraStrengthModel = character.lora_strength_model;
const loraStrengthClip = character.lora_strength_clip;

// The medium the character is drawn in. Asserting it helps a live actor hold
// together, but asserting the WRONG one overrides the reference: anime
// characters were rendering as live people because the word "photographic"
// beat the style in the reference image.
const STYLES = {
  photographic: { portrait: 'A head-and-shoulders photographic portrait', sheet: 'A hyper realistic photograph' },
  anime: { portrait: 'A head-and-shoulders anime illustration, cel shaded with clean line art', sheet: 'An anime illustration' },
  cartoon: { portrait: 'A head-and-shoulders cartoon illustration with bold outlines and flat colour', sheet: 'A cartoon illustration' },
  '3d_animated': { portrait: 'A head-and-shoulders 3D animated film still', sheet: 'A 3D animated film still' }
};
const STYLE = STYLES[character.render_style] || STYLES.photographic;

  // Framing is measured, not guessed. Scored against buffalo_l on this
  // project's own references: the Turnaround puts four heads in one frame and
  // yields a 53px face, and the old "MACRO EXTREME CLOSE-UP" yielded no
  // detectable face at all - a macro crop defeats the detector as surely as a
  // tiny one, because it needs the whole head plus margin. The qa_* shots below
  // land around 320px and score 0.69-0.90 against each other.
  //
  // These four match _character_qa_shots_node.js exactly, so a generated
  // character and a hand-uploaded one carry the same reference set and Face QA
  // compares like with like.
  const SPEC = {
    qa_front: { w: 1024, h: 1024, label: STYLE.portrait + ', cropped at the upper chest, facing the camera straight on, eyes to lens. The whole head is inside the frame with clear space above the hair and below the chin; do not crop the top of the head. Even soft lighting, plain mid-grey background, sharp focus on the face' },
    qa_threequarter_left: { w: 1024, h: 1024, label: STYLE.portrait + ', cropped at the upper chest, turned three-quarters to their left, looking slightly off camera. The whole head is inside the frame with clear space above the hair and below the chin; do not crop the top of the head. Even soft lighting, plain mid-grey background, sharp focus on the face' },
    qa_threequarter_right: { w: 1024, h: 1024, label: STYLE.portrait + ', cropped at the upper chest, turned three-quarters to their right, looking slightly off camera. The whole head is inside the frame with clear space above the hair and below the chin; do not crop the top of the head. Even soft lighting, plain mid-grey background, sharp focus on the face' },
    qa_low_angle: { w: 1024, h: 1024, label: STYLE.portrait + ', cropped at the upper chest, facing the camera with the head tilted slightly down, camera a little below eye level. The whole head is inside the frame with clear space above the hair and below the chin; do not crop the top of the head. Even soft lighting, plain mid-grey background, sharp focus on the face' },
    // Kept for the human-facing uses (costume, staging, inpaint plates). They
    // are poor identity references and Face QA skips the small ones.
    Turnaround: { w: 1536, h: 640, label: STYLE.sheet + ', a character TURNAROUND reference sheet, four full-body views in a row (front, three-quarter, side profile, back)' },
    Portrait: { w: 832, h: 1152, label: 'A HEAD-AND-SHOULDERS portrait, cropped at the chest, nothing below the chest visible, no waist, no legs, no shoes' },
    UpperTorso: { w: 1024, h: 1024, label: 'A WAIST-UP MEDIUM shot, cropped at the waist, no legs, no shoes, no full trousers visible' },
    FBody: { w: 768, h: 1344, label: 'A FULL-LENGTH FULL-BODY shot' }
  };
  const ALL_KINDS = ['qa_front', 'qa_threequarter_left', 'qa_threequarter_right', 'qa_low_angle', 'Turnaround', 'Portrait', 'UpperTorso', 'FBody'];

function resolveKind(kindRaw) {
  const t = kindRaw.toLowerCase();
  // A qa_* name passes through. 'closeup' now maps to qa_front rather than the
  // old macro crop: anything asking for a face shot should get one the
  // recogniser can actually read.
  if (/^qa_/.test(t)) return ALL_KINDS.indexOf(t) >= 0 ? t : 'qa_front';
  return /turn|around|360|angles|sheet/.test(t) ? 'Turnaround'
    : /close|face/.test(t) ? 'qa_front'
    : (/three.?quarter/.test(t) ? 'qa_threequarter_left'
    : (/port|head/.test(t) ? 'Portrait'
    : (/upper|torso|bust|medium/.test(t) ? 'UpperTorso' : 'FBody')));
}

const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

function buildMultipart(fields) {
  const boundary = '----FlowiseBoundary' + Math.random().toString(16).slice(2);
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

const refDocsRes = await axios.get(`${insforgeUrl}/api/database/records/documents`, {
  params: { character_id: `eq.${characterId}`, kind: 'eq.character_reference_image', 'shot_kind': 'not.is.null', select: 'id,storage_key,shot_kind' },
  headers: authHeaders
});
const manualByKind = new Map((refDocsRes.data || []).map((d) => [d.shot_kind, d]));

// Images are grouped into versions so a regenerate can sit BESIDE the previous
// attempt instead of destroying it. targetVersion comes from the caller; with
// none supplied this writes version 1, exactly as before.
const targetVersion = Number(resolved.targetVersion) > 0 ? Number(resolved.targetVersion) : 1;
const existingImgsRes = await axios.get(`${insforgeUrl}/api/database/records/character_images`, {
  params: { character_id: `eq.${characterId}`, version: `eq.${targetVersion}`, select: 'id,kind,image_path' },
  headers: authHeaders
});
const existingByKind = new Map((existingImgsRes.data || []).map((r) => [r.kind, r]));

async function upsertCharacterImage(kindDb, imagePath, seed) {
  const existing = existingByKind.get(kindDb);
  if (existing) {
    await axios.patch(`${insforgeUrl}/api/database/records/character_images`, { image_path: imagePath, seed }, {
      params: { id: `eq.${existing.id}` },
      headers: { ...authHeaders, 'Content-Type': 'application/json', Prefer: 'return=minimal' }
    });
  } else {
    await axios.post(`${insforgeUrl}/api/database/records/character_images`, { character_id: characterId, kind: kindDb, image_path: imagePath, seed, version: targetVersion, source: 'generated' }, {
      headers: { ...authHeaders, 'Content-Type': 'application/json', Prefer: 'return=minimal' }
    });
  }
}

async function useManualImage(KIND, doc) {
  const key = encodeURIComponent(doc.storage_key);
  const strategyRes = await axios.get(`${insforgeUrl}/api/storage/buckets/${bucketName}/download-strategy/objects/${key}`, { headers: authHeaders });
  const strategy = strategyRes.data;
  const fileHeaders = strategy.method === 'direct' ? authHeaders : {};
  const imgRes = await axios.get(strategy.url, { headers: fileHeaders, responseType: 'arraybuffer' });
  const imgBuffer = Buffer.from(imgRes.data);

  const subfolder = movieSlug + '/_CharacterRefs/' + characterName;
  const filename = characterName + '_' + KIND + '_00001_.png';

  const { body, boundary } = buildMultipart({
    type: 'input',
    subfolder,
    overwrite: 'true',
    image: { data: imgBuffer, filename, contentType: 'image/png' }
  });
  const uploadRes = await axios.post(comfyUrl + '/upload/image', body, {
    headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` }
  });
  if (uploadRes.status < 200 || uploadRes.status >= 300) {
    return { KIND, error: 'Upload to ComfyUI failed: ' + JSON.stringify(uploadRes.data).slice(0, 300) };
  }

  const imagePath = 'input/' + subfolder + '/' + filename;
  await upsertCharacterImage(KIND.toLowerCase(), imagePath, null);
  return { KIND, source: 'manual_upload', documentId: doc.id, imagePath };
}

async function generateOne(kindRaw) {
  const KIND = resolveKind(kindRaw);
  const W = SPEC[KIND].w;
  const H = SPEC[KIND].h;
  const includeIdentityText = !SPEC[KIND].skipIdentityText;
  const prompt = SPEC[KIND].label + ', shot of ' + gender + (includeIdentityText ? ', ' + visualAnchor + (clothing ? ', wearing ' + clothing : '') : '');
  const outputPrefix = movieSlug + '/_CharacterRefs/' + characterName + '/' + characterName + '_' + KIND;
  const seed = Math.floor(Math.random() * 1e9);

  const wf = {
    '1': { class_type: 'UNETLoader', inputs: { unet_name: 'flux-2-klein-9b.safetensors', weight_dtype: 'default' } },
    '2': { class_type: 'CLIPLoader', inputs: { clip_name: 'qwen_3_8b_fp8mixed.safetensors', type: 'flux2', device: 'default' } },
    '3': { class_type: 'VAELoader', inputs: { vae_name: 'flux2-vae.safetensors' } },
    '10': { class_type: 'EmptyFlux2LatentImage', inputs: { width: W, height: H, batch_size: 1 } },
    '20': { class_type: 'KSamplerSelect', inputs: { sampler_name: 'euler' } },
    '21': { class_type: 'Flux2Scheduler', inputs: { steps: 5, width: W, height: H } },
    '23': { class_type: 'RandomNoise', inputs: { noise_seed: seed } },
    '12': { class_type: 'VAEDecode', inputs: { samples: ['24', 0], vae: ['3', 0] } },
    '13': { class_type: 'SaveImage', inputs: { images: ['12', 0], filename_prefix: outputPrefix } }
  };

  let modelRef, clipRef;
  if (lora) {
    wf['4'] = { class_type: 'LoraLoader', inputs: { model: ['1', 0], clip: ['2', 0], lora_name: lora, strength_model: loraStrengthModel, strength_clip: loraStrengthClip } };
    modelRef = ['4', 0];
    clipRef = ['4', 1];
  } else {
    modelRef = ['1', 0];
    clipRef = ['2', 0];
  }
  wf['6'] = { class_type: 'CLIPTextEncode', inputs: { clip: clipRef, text: prompt.slice(0, 1100) } };
  wf['7'] = { class_type: 'ConditioningZeroOut', inputs: { conditioning: ['6', 0] } };
  wf['22'] = { class_type: 'CFGGuider', inputs: { cfg: 1, model: modelRef, positive: ['6', 0], negative: ['7', 0] } };
  wf['24'] = { class_type: 'SamplerCustomAdvanced', inputs: { noise: ['23', 0], guider: ['22', 0], sampler: ['20', 0], sigmas: ['21', 0], latent_image: ['10', 0] } };

  await axios.post(comfyUrl + '/free', { unload_models: true, free_memory: true });
  const submitRes = await axios.post(comfyUrl + '/prompt', { prompt: wf });
  const promptId = submitRes.data && submitRes.data.prompt_id;
  if (!promptId) return { KIND, error: 'Enqueue failed: ' + JSON.stringify(submitRes.data).slice(0, 400) };

  let outRel = null;
  for (let i = 0; i < 40; i++) {
    await sleep(4000);
    try {
      const h = await axios.get(comfyUrl + '/history/' + promptId);
      const rec = h.data && h.data[promptId];
      if (rec && rec.status && (rec.status.completed || rec.status.status_str)) {
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
  if (!outRel) return { KIND, error: 'Generation did not complete within the poll window' };

  const inputExists = async (rel) => {
    const parts = rel.split('/');
    const file = parts.pop();
    const sub = parts.join('/');
    try {
      const r = await axios.get(comfyUrl + '/view', {
        params: { filename: file, type: 'input', subfolder: sub },
        headers: { Range: 'bytes=0-0' },
        responseType: 'arraybuffer',
        validateStatus: () => true
      });
      return r.status >= 200 && r.status < 300;
    } catch (e) {
      return false;
    }
  };
  const copyOutToIn = async (srcOutRel, dstInRel) => {
    const cg = {
      '1': { class_type: 'JWImageLoadRGB', inputs: { path: String($comfyRoot || 'C:/ComfyUI2').replace(/[\\/]+$/, '') + '/output/' + srcOutRel } },
      '2': { class_type: 'JWImageSaveToPath', inputs: { image: ['1', 0], path: String($comfyRoot || 'C:/ComfyUI2').replace(/[\\/]+$/, '') + '/input/' + dstInRel, overwrite: 'true' } }
    };
    const rc = await axios.post(comfyUrl + '/prompt', { prompt: cg });
    const cpid = rc.data && rc.data.prompt_id;
    if (cpid) {
      for (let i = 0; i < 20; i++) {
        await sleep(2000);
        try {
          const h = await axios.get(comfyUrl + '/history/' + cpid);
          const rec = h.data && h.data[cpid];
          if (rec && rec.status && rec.status.status_str) break;
        } catch (e) {}
      }
    }
    return inputExists(dstInRel);
  };

  const finalRel = movieSlug + '/_CharacterRefs/' + characterName + '/' + characterName + '_' + KIND + '_00001_.png';
  if (!(await inputExists(movieSlug + '/_dirinit.png'))) {
    await copyOutToIn(outRel, movieSlug + '/_dirinit.png');
  }
  if (!(await inputExists(movieSlug + '/_CharacterRefs/_dirinit.png'))) {
    await copyOutToIn(outRel, movieSlug + '/_CharacterRefs/_dirinit.png');
  }
  if (!(await inputExists(movieSlug + '/_CharacterRefs/' + characterName + '/_dirinit.png'))) {
    await copyOutToIn(outRel, movieSlug + '/_CharacterRefs/' + characterName + '/_dirinit.png');
  }
  const staged = await copyOutToIn(outRel, finalRel);
  if (!staged) return { KIND, error: 'Generated but staging to input/ failed', outputPath: 'output/' + outRel };

  await upsertCharacterImage(KIND.toLowerCase(), 'input/' + finalRel, seed);
  return { KIND, source: 'generated', width: W, height: H, seed, lora: lora || null, prompt, imagePath: 'input/' + finalRel };
}

async function resolveOneKind(kindRaw) {
  const KIND = resolveKind(kindRaw);
  const kindDb = KIND.toLowerCase();
  const manualDoc = manualByKind.get(kindDb);
  if (manualDoc) return useManualImage(KIND, manualDoc);
  if (!force && existingByKind.has(kindDb)) {
    return { KIND, source: 'kept_existing', imagePath: existingByKind.get(kindDb).image_path };
  }
  return generateOne(kindRaw);
}

const kinds = requestedType ? [requestedType] : ALL_KINDS;
const results = [];
for (const k of kinds) {
  results.push(await resolveOneKind(k));
}

async function fetchStagedImageBase64(kindDb) {
  const row = existingByKind.get(kindDb) || (await axios.get(`${insforgeUrl}/api/database/records/character_images`, {
    params: { character_id: `eq.${characterId}`, kind: `eq.${kindDb}`, select: 'image_path' },
    headers: authHeaders
  }).then((r) => (r.data || [])[0]));
  if (!row) return null;
  const rel = row.image_path.replace(/^input\//, '');
  const parts = rel.split('/');
  const filename = parts.pop();
  const subfolder = parts.join('/');
  try {
    const imgRes = await axios.get(comfyUrl + '/view', { params: { filename, subfolder, type: 'input' }, responseType: 'arraybuffer' });
    return Buffer.from(imgRes.data).toString('base64');
  } catch (e) {
    return null;
  }
}

async function visionDescribe(b64, prompt) {
  try {
    const res = await axios.post(ollamaBaseUrl + '/api/generate', {
      model: ollamaModel,
      prompt,
      images: [b64],
      stream: false,
      think: false,
      options: { keep_alive: '0' }
    }, { timeout: 120000 });
    return (res.data.response || '').trim() || null;
  } catch (e) {
    return null;
  }
}

const reconcile = { visualAnchorUpdated: false, clothingUpdated: false };
const closeUpB64 = await fetchStagedImageBase64('closeup');
if (closeUpB64) {
  const newAnchor = await visionDescribe(
    closeUpB64,
    "Describe ONLY this person's physical appearance for use as a character reference: hair color/style, facial hair, build, apparent age, distinguishing facial features. Do not mention clothing, background, pose, or emotion. One or two plain sentences."
  );
  const newDescriptor = await visionDescribe(
    closeUpB64,
    "Describe ONLY this person's gender, head features (hair color/style, facial hair if any), and attire (clothing, colors). One or two plain sentences. Nothing else - no scene, no background, no pose, no emotion, no name."
  );
  const patch = {};
  if (newAnchor) {
    patch.visual_anchor = newAnchor;
    reconcile.visualAnchorUpdated = true;
  }
  if (newDescriptor) patch.visual_descriptor = newDescriptor;
  if (Object.keys(patch).length > 0) {
    await axios.patch(`${insforgeUrl}/api/database/records/characters`, patch, {
      params: { id: `eq.${characterId}` },
      headers: { ...authHeaders, 'Content-Type': 'application/json', Prefer: 'return=minimal' }
    });
  }
}
for (const kindDb of ['fbody', 'uppertorso', 'portrait']) {
  const b64 = await fetchStagedImageBase64(kindDb);
  if (!b64) continue;
  const newClothing = await visionDescribe(
    b64,
    "Describe ONLY this person's clothing/outfit for use as a character reference: garment types, colors, style. Do not mention their face, hair, body, background, or pose. One or two plain sentences."
  );
  if (newClothing) {
    await axios.patch(`${insforgeUrl}/api/database/records/characters`, { clothing: newClothing }, {
      params: { id: `eq.${characterId}` },
      headers: { ...authHeaders, 'Content-Type': 'application/json', Prefer: 'return=minimal' }
    });
    reconcile.clothingUpdated = true;
  }
  break;
}

return { action: 'generated', characterId, characterName, lora: lora || null, results, reconcile };
