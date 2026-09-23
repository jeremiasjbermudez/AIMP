const resolved = JSON.parse($resolveOutput);
if (resolved.error) return { action: 'error', reason: resolved.error };

const { movieId, movieSlug, act, sceneNumber, force, panoImagePath, locationSlug } = resolved;

// How hard to look at the room. The resolver turns --quality and the individual
// flags into this; absent it (an older caller, a hand-run) the defaults are the
// behaviour this flow has always had, so nothing changes for anyone who does
// not ask for more.
const build = resolved.build || {
  quality: 'legacy', navTraj: false, detailTraj: false, anchors: 0,
  maxTraj: 0, steps: 5001, detailObjects: 6, seed: 1
};

const axios = require('axios');
const insforgeUrl = $insforgeUrl;
const insforgeApiKey = $insforgeApiKey;
// @include comfy_world

// HY-World graphs run on the world ComfyUI, started on demand (see lib/comfy_world.js).
const comfyUrl = await worldComfyUrl();
const authHeaders = { Authorization: `Bearer ${insforgeApiKey}` };
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

const waitFor = async (pid, maxTries, everyMs) => {
  for (let k = 0; k < maxTries; k++) {
    await sleep(everyMs);
    try {
      const h = await axios.get(comfyUrl + '/history/' + pid);
      const rec = h.data && h.data[pid];
      if (rec && rec.status && rec.status.status_str) return rec;
    } catch (e) {}
  }
  return null;
};

async function upsertSplat(patch) {
  const existingRes = await axios.get(`${insforgeUrl}/api/database/records/scene_splats`, {
    params: { movie_id: `eq.${movieId}`, act_number: `eq.${act}`, scene_number: `eq.${sceneNumber}`, select: 'id' },
    headers: authHeaders
  });
  const existing = (existingRes.data || [])[0];
  if (existing) {
    await axios.patch(`${insforgeUrl}/api/database/records/scene_splats`, patch, {
      params: { id: `eq.${existing.id}` },
      headers: { ...authHeaders, 'Content-Type': 'application/json', Prefer: 'return=minimal' }
    });
  } else {
    await axios.post(`${insforgeUrl}/api/database/records/scene_splats`, { movie_id: movieId, act_number: act, scene_number: sceneNumber, ...patch }, {
      headers: { ...authHeaders, 'Content-Type': 'application/json', Prefer: 'return=minimal' }
    });
  }
}

// An explicit --workspace wins: it names the folder the trajectories, floor
// plan and cameras were made in, and the point of a rebuild is to improve
// THAT world, not to start another beside it.
const workspaceName = (build.workspace && String(build.workspace)) || ('Act' + act + 'Scene' + sceneNumber + locationSlug);
const rootDir = String($comfyRoot || 'C:/ComfyUI2').replace(/[\\/]+$/, '') + '/output/' + movieSlug + '/hyworld2_worldgen';
const finalPlyName = workspaceName + '_point_cloud_5000.ply';
const plyDir = movieSlug + '/hyworld2_worldgen/' + workspaceName + '/gs_results/ply';
const finalPlyPath = String($comfyRoot || 'C:/ComfyUI2').replace(/[\\/]+$/, '') + '/output/' + plyDir + '/' + finalPlyName;

const existingRes = await axios.get(`${insforgeUrl}/api/database/records/scene_splats`, {
  params: { movie_id: `eq.${movieId}`, act_number: `eq.${act}`, scene_number: `eq.${sceneNumber}`, select: 'id,ply_path,workspace_name' },
  headers: authHeaders
});
const existing = (existingRes.data || [])[0];
// --resume continues the recorded world. It needs one to continue, and it
// overwrites that world's ply with the continued one, so it is treated like
// --force from here on: the old ply is backed up first, never destroyed.
const resume = Boolean(build.resume);
// Without --workspace the name is derived, and continuing a derived name that
// is not the recorded world would train the wrong folder (or none). With an
// explicit --workspace the operator has named the world; the trainer itself
// refuses if that folder holds no checkpoint.
if (resume && !build.workspace && !existing) {
  return { action: 'error', reason: `--resume needs an existing world for A${act}S${sceneNumber} and there is none. Build it first, or name the workspace with --workspace.`, sceneNumber, act };
}
if (resume && !build.workspace && existing && existing.workspace_name && existing.workspace_name !== workspaceName) {
  return { action: 'error', reason: `--resume would continue workspace ${workspaceName} but the recorded world is ${existing.workspace_name}. Pass --workspace ${existing.workspace_name}.`, sceneNumber, act };
}
if (existing && !force && !resume) {
  return { action: 'skipped', reason: 'splat already exists for this scene - use --force to rebuild (existing .ply is backed up first, never destroyed)', sceneNumber, act, plyPath: existing.ply_path };
}

let backupPath = null;
// A backup protects the file this build will OVERWRITE. When the build targets
// a different workspace than the recorded splat lives in (--workspace), that
// file is not touched at all, so renaming it away is not protection - it is
// moving another world's ply into this one's folder. Skip it.
const sameWorkspace = !existing || !existing.workspace_name || existing.workspace_name === workspaceName;
if (existing && (force || resume) && sameWorkspace) {
  backupPath = finalPlyPath.replace(/\.ply$/, '_backup_' + Date.now() + '.ply');
  const backupGraph = { '1': { class_type: 'RenameFile', inputs: { source_path: existing.ply_path, dest_path: backupPath } } };
  const br = await axios.post(comfyUrl + '/prompt', { prompt: backupGraph });
  const bpid = br.data && br.data.prompt_id;
  if (!bpid) return { action: 'error', reason: 'Forced retrain aborted: could not enqueue backup of the existing splat. Nothing was touched.' };
  const brec = await waitFor(bpid, 600, 2000);
  if (!brec || brec.status.status_str === 'error') {
    return { action: 'error', reason: 'Forced retrain aborted: backup of existing splat failed or did not finish within 20 minutes (ComfyUI busy?). Nothing was overwritten.', details: brec && brec.status && brec.status.messages };
  }
}

// Which panorama this world was built from. A workspace's trajectory cache is
// keyed on it, so building into an EXISTING workspace (--workspace, which is
// what a resume always does) has to use that workspace's own panorama.png -
// the scene's record may since have been replaced by a different picture, and
// then every cached trajectory misses and the build quietly makes a new world.
// An explicit --panorama still wins.
const panoRel = build.panorama || !build.workspace
  ? panoImagePath
  : 'output/' + movieSlug + '/hyworld2_worldgen/' + workspaceName + '/panorama.png';
const srcPanoAbs = String($comfyRoot || 'C:/ComfyUI2').replace(/[\\/]+$/, '') + '/' + panoRel;
const flatPanoName = movieSlug + '_scene' + sceneNumber + '_panorama.png';
const copyGraph = {
  '1': { class_type: 'JWImageLoadRGB', inputs: { path: srcPanoAbs } },
  '2': { class_type: 'JWImageSaveToPath', inputs: { image: ['1', 0], path: String($comfyRoot || 'C:/ComfyUI2').replace(/[\\/]+$/, '') + '/input/' + flatPanoName, overwrite: 'true' } }
};
const cr = await axios.post(comfyUrl + '/prompt', { prompt: copyGraph });
const cpid = cr.data && cr.data.prompt_id;
if (!cpid) return { action: 'error', reason: 'Stage failed: could not enqueue copy of the panorama into the flat input root.' };
const crec = await waitFor(cpid, 30, 2000);
if (!crec || crec.status.status_str === 'error') {
  return { action: 'error', reason: `Stage failed: copy graph errored - does ${srcPanoAbs} actually exist?`, details: crec && crec.status && crec.status.messages };
}

const wf = {
  '45': { class_type: 'HYWorld2MemoryAlignment', inputs: { worldmirror_batch: ['820', 3], raw_splats: ['835', 5], ply_data: ['835', 0], mode: 'align_and_export', downsampled_pts: 2000000, debug_mode: false } },
  '822': { class_type: 'HYWorld2Workspace', inputs: { panorama: ['1', 0], workspace_name: workspaceName, root_dir: rootDir, scene_dir: '', scene_type: 'unknown', result_name: 'worldstereo-memory-dmd' } },
  '830': { class_type: 'HYWorld2MemoryBank', inputs: { workspace: ['822', 0], trajectory_set: ['834', 0], image_width: 0, image_height: 0, nframe: 0, max_reference: 8, align_nframe: 8, downsampled_pts: 2000000, kb_anomaly_percentile: 90 } },
  '817': { class_type: 'VNCCS_LoadWorldStereoLightModel', inputs: { model: 'Memory DMD Light INT4', offload_mode: 'sequential_cpu_offload', device: 'cuda' } },
  '834': { class_type: 'HYWorld2Trajectories', inputs: { workspace: ['822', 0], seed: build.seed, scene_type: 'auto', additional_nav_traj: build.navTraj, extreme_detail_traj: build.detailTraj, detail_object_limit: build.detailObjects, qwen_model_id: 'Qwen3-VL-4B-Instruct', qwen_quantization: '4-bit (VRAM-friendly)', qwen_max_image_edge: 768, apply_anchor_scan: build.anchors > 0, anchor_scan_topk: Math.max(1, build.anchors) } },
  '820': { class_type: 'HYWorld2PrepareWorldMirrorBatch', inputs: { memory_bank: ['833', 0] } },
  '835': { class_type: 'VNCCS_WorldMirrorV2_3D', inputs: { model: ['10', 0], images: ['820', 0], camera_intrinsics: ['820', 2], camera_poses: ['820', 1], target_size: 840, offload_scheme: 'none', low_vram_mode: true, apply_sky_mask: false, debug_log: false, enable_splat_upsample: true, splat_upsample_scale: 0.003, splat_upsample_scale_mode: 'depth_adaptive', splat_upsample_depth_scale_strength: 1, splat_upsample_depth_scale_max: 3, splat_upsample_voxel_prune: true, splat_upsample_voxel_size: 0.0015, splat_upsample_max_points: 5000000, splat_upsample_cap_far_bias: 1.75, splat_camera_source: 'camera_inputs' } },
  '833': { class_type: 'HYWorld2WorldExpansion', inputs: { workspace: ['822', 0], memory_bank: ['830', 0], trajectory_set: ['834', 0], model: ['817', 0], qwen_model_id: 'Qwen3-VL-4B-Instruct', qwen_quantization: '4-bit (VRAM-friendly)', qwen_attention_mode: 'auto', qwen_max_image_edge: 768, qwen_max_new_tokens: 512, qwen_keep_model_loaded: true, qwen_frame_count: 4, seed: build.seed, max_trajectories: build.maxTraj } },
  '10': { class_type: 'VNCCS_LoadWorldMirrorV2Model', inputs: { device: 'cuda', precision: 'fp8' } },
  '13': { class_type: 'HYWorld2GSData', inputs: { workspace: ['822', 0], memory_bank: ['45', 0], mode: 'build', result_name: 'worldstereo-memory-dmd', out_name: 'gs_data', save_normal: true, split_sky: true, split_align: false } },
  '837': { class_type: 'HYWorld2Train3DGS', inputs: { gs_data: ['13', 0], train_sampling_preset: 'standard', batch_size: 1, patch_size: 'Full', max_steps: build.steps, save_steps: String(build.steps), eval_steps: String(build.steps), ply_steps: String(build.steps), downsample_pts_num: 2000001, save_ply: true, disable_video: true, disable_viewer: true, depth_loss: true, normal_loss: true, sky_depth_from_pcd: false, use_scale_regularization: true, use_mask_gaussian: true, mask_export_stochastic: true, mask_export_anchor_protection: false, use_anchor_protection: true, do_prune: false, prune_opacity_threshold: 0.01, antialiased: true, normalize_world_space: true, export_mesh: true, strategy_refine_start_iter: 150, strategy_refine_stop_iter: 750, strategy_refine_every: 100, strategy_refine_scale2d_stop_iter: 750, strategy_reset_every: 99990, strategy_grow_grad2d: 0.0001, strategy_prune_scale3d: 0.1, convert_ply_to_worldmirror_preview_basis: false, resume_ckpt: resume ? 'latest' : '' } },
  '1': { class_type: 'LoadImage', inputs: { image: flatPanoName } },
  '15': { class_type: 'VNCCS_BackgroundPreview', inputs: { ply_path: ['837', 0], camera_poses: ['837', 1], camera_intrinsics: ['837', 2], coordinate_basis: 'hyworld2_worldgen' } },
  '900': { class_type: 'RenameFile', inputs: { source_path: ['837', 0], dest_path: finalPlyPath } }
};

await axios.post(comfyUrl + '/free', { unload_models: true, free_memory: true });
const r = await axios.post(comfyUrl + '/prompt', { prompt: wf });
const pid = r.data && r.data.prompt_id;
if (!pid) return { action: 'error', reason: 'World build enqueue failed', details: (r.data && r.data.node_errors) || r.data };

// A build is 50 minutes on A1S2 and hours at higher quality. Returning
// 'pending' at 25 minutes left every longer build unrecorded: the ply was
// renamed in place but scene_splats never learned of it. Wait as long as a
// build can take; 'pending' is the fallback, not the normal path.
const rec = await waitFor(pid, 2880, 5000);
if (!rec) return { action: 'pending', reason: 'World build still running past the poll window', promptId: pid };
if (rec.status.status_str === 'error') return { action: 'error', reason: 'World build failed in ComfyUI', details: rec.status.messages, promptId: pid };

await upsertSplat({ workspace_name: workspaceName, ply_path: finalPlyPath, backup_path: backupPath, prompt_id: pid });
// Floor plans render their plates from the ply they recorded. A plan made on
// this world must follow the world to its new file, or the Camera tab keeps
// rendering the previous training. (A resume keeps the frame, so the plan's
// landmarks stay valid; a from-scratch rebuild changes the frame and the plan
// needs a new survey, but pointing it at the live ply is still right.)
await axios.patch(`${insforgeUrl}/api/database/records/scene_floor_plans`, { ply_path: finalPlyPath }, {
  params: { movie_id: `eq.${movieId}`, act_number: `eq.${act}`, scene_number: `eq.${sceneNumber}`, world_name: `eq.${workspaceName}` },
  headers: { ...authHeaders, 'Content-Type': 'application/json', Prefer: 'return=minimal' }
});

return {
  action: resume ? 'resumed' : force && backupPath ? 'rebuilt' : 'generated',
  sceneNumber,
  act,
  workspaceName,
  plyPath: finalPlyPath,
  backupPath,
  promptId: pid
};
