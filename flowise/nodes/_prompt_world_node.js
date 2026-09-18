// A 3D world from a prompt alone, with no scene behind it.
//
// Both halves of this already existed but only ever ran scene-first: the
// panoramic generator resolves an A1S3 scope and writes scene_panos, and the
// world builder reads that row back. Neither could be pointed at an idea that
// is not yet in the screenplay.
//
// HY-World 2.0 takes text directly. Its documentation is explicit that
// panorama generation is an INTERNAL stage, not a user-supplied input, so this
// runs the pipeline's own stages end to end: HY-Pano 2.0 (Qwen) turns the
// prompt into a 360, then the world chain the scene builder already uses -
// workspace, trajectories, memory bank, world expansion, WorldMirror, GS data,
// Train3DGS.
//
// Results go to `prompt_worlds`, not `scene_splats`: that table's act_number
// and scene_number are NOT NULL with a UNIQUE (movie, act, scene) constraint,
// so a scene-less world has nowhere to sit and two of them would collide.
const axios = require('axios');

const insforgeUrl = $insforgeUrl;
const insforgeApiKey = $insforgeApiKey;
const comfyUrl = $comfyUrl;
const authHeaders = { Authorization: `Bearer ${insforgeApiKey}` };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let parsed;
try {
  parsed = JSON.parse(($flow.input || '').toString());
} catch (e) {
  return { error: 'Expected JSON {"worldId":"..."}' };
}
if (!parsed.worldId) return { error: 'Missing worldId.' };

const worldRes = await axios.get(`${insforgeUrl}/api/database/records/prompt_worlds`, {
  params: { id: `eq.${parsed.worldId}`, select: '*' },
  headers: authHeaders
});
const world = (worldRes.data || [])[0];
if (!world) return { error: 'That world no longer exists.' };

const movieRes = await axios.get(`${insforgeUrl}/api/database/records/movies`, {
  params: { id: `eq.${world.movie_id}`, select: 'id,slug' },
  headers: authHeaders
});
const movie = (movieRes.data || [])[0];
if (!movie) return { error: 'Movie not found.' };

async function update(patch) {
  await axios.patch(`${insforgeUrl}/api/database/records/prompt_worlds`, patch, {
    params: { id: `eq.${world.id}` },
    headers: { ...authHeaders, 'Content-Type': 'application/json' }
  });
}

async function waitFor(promptId, tries, everyMs) {
  for (let i = 0; i < tries; i++) {
    await sleep(everyMs);
    try {
      const h = await axios.get(comfyUrl + '/history/' + promptId);
      const rec = h && h.data && h.data[promptId];
      if (rec && rec.status && rec.status.status_str) return rec;
    } catch (e) {}
  }
  return null;
}

async function fail(reason) {
  await update({ status: 'failed', error_message: String(reason).slice(0, 900) });
  return { action: 'error', reason: reason };
}

await update({ status: 'rendering', error_message: null });

// A workspace name ComfyUI can use as a folder: letters and digits only, and
// the id tail so two worlds with the same name never share a workspace.
const slug = String(world.name).replace(/[^A-Za-z0-9]+/g, '') || 'World';
const workspaceName = 'Prompt' + slug.slice(0, 40) + world.id.replace(/-/g, '').slice(0, 8);

// --------------------------------------------- 1. HY-Pano 2.0 (internal)
//
// This is NOT a panorama you supply - HY-World 2.0 takes text directly and
// generates the 360 itself as its first stage. Earlier this node produced the
// panorama with Flux instead, which is a different model doing a job HY-World
// already does, and it framed an internal stage as a step the operator had to
// take.
//
// HY-Pano-2-Qwen is Qwen-Image-Edit plus the panorama LoRA. It takes an `image`
// because it OUTPAINTS a 360 into a wide canvas rather than sampling from
// nothing - so for text-to-world the input is a blank canvas at the panorama's
// own aspect, which is exactly what QwenPanoEncoder's wide_canvas output is.
const PANO_W = 1952;
const PANO_H = 960;

const flatPanoName = movie.slug + '_promptworld_' + world.id.replace(/-/g, '').slice(0, 8) + '.png';
const panoPrefix = movie.slug + '/_prompt_worlds/' + workspaceName;

const panoGraph = {
  '1': { class_type: 'UNETLoader', inputs: { unet_name: 'qwen_image_edit_2511_bf16.safetensors', weight_dtype: 'default' } },
  '2': { class_type: 'LoraLoaderModelOnly', inputs: { model: ['1', 0], lora_name: 'panorama-v2-qwen-image-2512_15.safetensors', strength_model: 1 } },
  '3': { class_type: 'CLIPLoader', inputs: { clip_name: 'qwen\\qwen_2.5_vl_7b.safetensors', type: 'qwen_image', device: 'default' } },
  '4': { class_type: 'VAELoader', inputs: { vae_name: 'qwen-image\\qwen_image_vae.safetensors' } },
  '5': { class_type: 'EmptyImage', inputs: { width: PANO_W, height: PANO_H, batch_size: 1, color: 0 } },
  // use_official_prompt lets HY-Pano apply its own prompt scaffolding rather
  // than having us hand-write panorama boilerplate around the description.
  '6': {
    class_type: 'HYWorld2QwenPanoEncoder',
    inputs: {
      image: ['5', 0], scene_prompt: scenePrompt, width: PANO_W, height: PANO_H,
      batch_size: 1, canvas_value: 0, crop_border: 0, use_official_prompt: true
    }
  },
  '7': {
    class_type: 'HYWorld2QwenPanoGenerate',
    inputs: {
      model: ['2', 0], clip: ['3', 0], vae: ['4', 0],
      // wide_canvas_image, the second output - the canvas it outpaints into.
      image: ['6', 1],
      prompt: scenePrompt, width: PANO_W, height: PANO_H, seed: seed,
      steps: 40, cfg: 4, sampler_name: 'euler', scheduler: 'simple', denoise: 1,
      blend_width: 32, crop_border: 0, ref_latents_method: 'index',
      use_official_prompt: true, crop_right_edge: true
    }
  },
  // A 360 has to wrap; the seam blend is what makes the left and right edges
  // meet, and the world builder reads it as a sphere.
  '8': { class_type: 'HYWorld2QwenPanoSeamBlend', inputs: { image: ['7', 0], blend_width: 32, crop_right_edge: true } },
  '9': { class_type: 'SaveImage', inputs: { images: ['8', 0], filename_prefix: panoPrefix } },
  '10': { class_type: 'JWImageSaveToPath', inputs: { image: ['8', 0], path: 'C:/ComfyUI2/input/' + flatPanoName, overwrite: 'true' } }
};

let pr;
try {
  pr = await axios.post(comfyUrl + '/prompt', { prompt: panoGraph });
} catch (e) {
  const body = (e && e.response && e.response.data) || (e && e.message) || String(e);
  return await fail('ComfyUI rejected the HY-Pano graph: ' + JSON.stringify(body).slice(0, 900));
}
const ppid = pr.data && pr.data.prompt_id;
if (!ppid) return await fail('Could not enqueue HY-Pano.');

const prec = await waitFor(ppid, 180, 5000);
if (!prec) return await fail('Timed out waiting for HY-Pano.');
if (prec.status.status_str === 'error') {
  return await fail('HY-Pano failed: ' + JSON.stringify(prec.status.messages || '').slice(-700));
}

let panoRel = null;
const pouts = prec.outputs || {};
for (const k of Object.keys(pouts)) {
  const imgs = pouts[k].images || [];
  if (imgs.length) {
    panoRel = (imgs[0].subfolder ? imgs[0].subfolder + '/' : '') + imgs[0].filename;
    break;
  }
}
if (!panoRel) return await fail('HY-Pano ran but produced no panorama.');
const panoPath = 'output/' + panoRel;
await update({ pano_path: panoPath, workspace_name: workspaceName });

// --------------------------------------------------------- 2. the world
//
// The world builder's graph, unchanged. `finalPlyPath` follows the same layout
// so a prompt world sits beside the scene worlds rather than in a tree of its
// own - inside the movie's folder, which is where everything else lives.
const rootDir = 'C:/ComfyUI2/output/' + movie.slug + '/hyworld2_worldgen';
const finalPlyName = workspaceName + '_point_cloud_5000.ply';
const finalPlyPath = rootDir + '/' + workspaceName + '/gs_results/ply/' + finalPlyName;

const wf = {
  '45': { class_type: 'HYWorld2MemoryAlignment', inputs: { worldmirror_batch: ['820', 3], raw_splats: ['835', 5], ply_data: ['835', 0], mode: 'align_and_export', downsampled_pts: 2000000, debug_mode: false } },
  '822': { class_type: 'HYWorld2Workspace', inputs: { panorama: ['1', 0], workspace_name: workspaceName, root_dir: rootDir, scene_dir: '', scene_type: 'unknown', result_name: 'worldstereo-memory-dmd' } },
  '830': { class_type: 'HYWorld2MemoryBank', inputs: { workspace: ['822', 0], trajectory_set: ['834', 0], image_width: 0, image_height: 0, nframe: 0, max_reference: 8, align_nframe: 8, downsampled_pts: 2000000, kb_anomaly_percentile: 90 } },
  '817': { class_type: 'VNCCS_LoadWorldStereoLightModel', inputs: { model: 'Memory DMD Light INT4', offload_mode: 'sequential_cpu_offload', device: 'cuda' } },
  '834': { class_type: 'HYWorld2Trajectories', inputs: { workspace: ['822', 0], seed: 1, scene_type: 'auto', additional_nav_traj: false, extreme_detail_traj: false, detail_object_limit: 6, qwen_model_id: 'Qwen3-VL-4B-Instruct', qwen_quantization: '4-bit (VRAM-friendly)', qwen_max_image_edge: 768, apply_anchor_scan: false, anchor_scan_topk: 2 } },
  '820': { class_type: 'HYWorld2PrepareWorldMirrorBatch', inputs: { memory_bank: ['833', 0] } },
  '835': { class_type: 'VNCCS_WorldMirrorV2_3D', inputs: { model: ['10', 0], images: ['820', 0], camera_intrinsics: ['820', 2], camera_poses: ['820', 1], target_size: 840, offload_scheme: 'none', low_vram_mode: true, apply_sky_mask: false, debug_log: false, enable_splat_upsample: true, splat_upsample_scale: 0.003, splat_upsample_scale_mode: 'depth_adaptive', splat_upsample_depth_scale_strength: 1, splat_upsample_depth_scale_max: 3, splat_upsample_voxel_prune: true, splat_upsample_voxel_size: 0.0015, splat_upsample_max_points: 5000000, splat_upsample_cap_far_bias: 1.75, splat_camera_source: 'camera_inputs' } },
  '833': { class_type: 'HYWorld2WorldExpansion', inputs: { workspace: ['822', 0], memory_bank: ['830', 0], trajectory_set: ['834', 0], model: ['817', 0], qwen_model_id: 'Qwen3-VL-4B-Instruct', qwen_quantization: '4-bit (VRAM-friendly)', qwen_attention_mode: 'auto', qwen_max_image_edge: 768, qwen_max_new_tokens: 512, qwen_keep_model_loaded: true, qwen_frame_count: 4, seed: 1, max_trajectories: 0 } },
  '10': { class_type: 'VNCCS_LoadWorldMirrorV2Model', inputs: { device: 'cuda', precision: 'fp8' } },
  '13': { class_type: 'HYWorld2GSData', inputs: { workspace: ['822', 0], memory_bank: ['45', 0], mode: 'build', result_name: 'worldstereo-memory-dmd', out_name: 'gs_data', save_normal: true, split_sky: true, split_align: false } },
  '837': { class_type: 'HYWorld2Train3DGS', inputs: { gs_data: ['13', 0], train_sampling_preset: 'standard', batch_size: 1, patch_size: 'Full', max_steps: 5001, save_steps: '5001', eval_steps: '5001', ply_steps: '5001', downsample_pts_num: 2000001, save_ply: true, disable_video: true, disable_viewer: true, depth_loss: true, normal_loss: true, sky_depth_from_pcd: false, use_scale_regularization: true, use_mask_gaussian: true, mask_export_stochastic: true, mask_export_anchor_protection: false, use_anchor_protection: true, do_prune: false, prune_opacity_threshold: 0.01, antialiased: true, normalize_world_space: true, export_mesh: true, strategy_refine_start_iter: 150, strategy_refine_stop_iter: 750, strategy_refine_every: 100, strategy_refine_scale2d_stop_iter: 750, strategy_reset_every: 99990, strategy_grow_grad2d: 0.0001, strategy_prune_scale3d: 0.1, convert_ply_to_worldmirror_preview_basis: false } },
  '1': { class_type: 'LoadImage', inputs: { image: flatPanoName } },
  '15': { class_type: 'VNCCS_BackgroundPreview', inputs: { ply_path: ['837', 0], camera_poses: ['837', 1], camera_intrinsics: ['837', 2], coordinate_basis: 'hyworld2_worldgen' } },
  '900': { class_type: 'RenameFile', inputs: { source_path: ['837', 0], dest_path: finalPlyPath } }
};

let wr;
try {
  wr = await axios.post(comfyUrl + '/prompt', { prompt: wf });
} catch (e) {
  const body = (e && e.response && e.response.data) || (e && e.message) || String(e);
  return await fail('ComfyUI rejected the world graph: ' + JSON.stringify(body).slice(0, 900));
}
const wpid = wr.data && wr.data.prompt_id;
if (!wpid) return await fail('Could not enqueue the world build.');

// 3DGS training is the long part - 5001 steps. An hour of headroom.
const wrec = await waitFor(wpid, 720, 5000);
if (!wrec) return await fail('Timed out waiting for the world build. It may still be running in ComfyUI.');
if (wrec.status.status_str === 'error') {
  return await fail('The world build failed: ' + JSON.stringify(wrec.status.messages || '').slice(-700));
}

await update({ status: 'complete', ply_path: finalPlyPath, error_message: null });

return {
  action: 'complete',
  worldId: world.id,
  name: world.name,
  workspaceName: workspaceName,
  panoPath: panoPath,
  plyPath: finalPlyPath
};
