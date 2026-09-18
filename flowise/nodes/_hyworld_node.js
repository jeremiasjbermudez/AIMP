// HY-World 2.0: a navigable 3D world from text, an image, or a video.
//
// Written against the HY-World 2.0 pipeline as documented, not assembled from
// anything else in this project. Its five stages, in order:
//
//   1. HY-Pano 2.0      text or a single image -> a 360 panorama
//   2. WorldNav         VLM-guided camera trajectory planning
//   3. WorldStereo 2.0  panorama -> keyframes with memory-guided consistency
//   4. WorldMirror 2.0  depth, normals, cameras, point cloud, 3DGS attributes
//   5. 3DGS training    the persistent, editable splat
//
// The panorama is an INTERNAL stage. Nothing here asks for one, and nothing
// here touches the scene panoramas - those exist for Qwen Cleanup and are a
// different job entirely.
//
// Two entry points, because the pipeline has two:
//
//   text / image -> stages 1-5.
//   video / multi-view -> straight into WorldMirror 2.0, which predicts its own
//     cameras and emits 3DGS attributes in a single forward pass. The docs are
//     explicit that this bypasses panorama generation, so this path has no
//     panorama, no trajectories and no training run - it is a reconstruction of
//     something that already exists rather than an invention of somewhere new.
const axios = require('axios');
const fs = require('fs');
const path = require('path');

const insforgeUrl = $insforgeUrl;
const insforgeApiKey = $insforgeApiKey;
const comfyUrl = $comfyUrl;
const comfyRoot = $comfyRoot;
const authHeaders = { Authorization: `Bearer ${insforgeApiKey}` };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const BS = String.fromCharCode(92);

let parsed;
try {
  parsed = JSON.parse(($flow.input || '').toString());
} catch (e) {
  return { error: 'Expected JSON {"worldId":"..."}' };
}
if (!parsed.worldId) return { error: 'Missing worldId.' };

const worldRes = await axios.get(`${insforgeUrl}/api/database/records/hyworlds`, {
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
  await axios.patch(`${insforgeUrl}/api/database/records/hyworlds`, patch, {
    params: { id: `eq.${world.id}` },
    headers: { ...authHeaders, 'Content-Type': 'application/json' }
  });
}

async function fail(reason) {
  await update({ status: 'failed', error_message: String(reason).slice(0, 900) });
  return { action: 'error', reason: reason };
}

/** Submit a graph and wait for it. Returns the history record, or null. */
async function run(graph, tries, label) {
  let r;
  try {
    r = await axios.post(comfyUrl + '/prompt', { prompt: graph });
  } catch (e) {
    const body = (e && e.response && e.response.data) || (e && e.message) || String(e);
    throw new Error(label + ' was rejected by ComfyUI: ' + JSON.stringify(body).slice(0, 800));
  }
  const pid = r.data && r.data.prompt_id;
  if (!pid) throw new Error(label + ' could not be queued: ' + JSON.stringify(r.data).slice(0, 500));
  for (let i = 0; i < tries; i++) {
    await sleep(5000);
    try {
      const h = await axios.get(comfyUrl + '/history/' + pid);
      const rec = h && h.data && h.data[pid];
      if (rec && rec.status && rec.status.status_str) {
        if (rec.status.status_str === 'error') {
          throw new Error(label + ' failed: ' + JSON.stringify(rec.status.messages || '').slice(-700));
        }
        return rec;
      }
    } catch (e) {
      if (String(e.message || '').startsWith(label)) throw e;
    }
  }
  throw new Error(label + ' timed out. It may still be running in ComfyUI.');
}

// No Y-up copy is written. World generation picks its up axis per scene
// (position_meta_info.json up_direction: +Z for one, -Z for another), so a
// fixed 180-degree flip capsized as many splats as it righted. The HY-World
// viewer reads that up_direction and turns each splat upright on load.

function firstImage(rec) {
  for (const k of Object.keys(rec.outputs || {})) {
    const imgs = rec.outputs[k].images || [];
    if (imgs.length) return (imgs[0].subfolder ? imgs[0].subfolder + '/' : '') + imgs[0].filename;
  }
  return null;
}

/** LoadImage and VHS read from input/, so anything under output/ is copied in. */
function stage(rel, destName) {
  const norm = String(rel).split(BS).join('/');
  if (norm.toLowerCase().indexOf('input/') === 0) return norm.slice('input/'.length);
  const src = path.join(comfyRoot, norm);
  if (!fs.existsSync(src)) return null;
  const dest = '_hyworld/' + destName + path.extname(norm);
  const destAbs = path.join(comfyRoot, 'input', dest);
  fs.mkdirSync(path.dirname(destAbs), { recursive: true });
  fs.copyFileSync(src, destAbs);
  return dest;
}

await update({ status: 'rendering', error_message: null });

const shortId = world.id.replace(/-/g, '').slice(0, 8);
const nameSlug = String(world.name).replace(/[^A-Za-z0-9]+/g, '').slice(0, 40) || 'World';
const workspaceName = 'HYW' + nameSlug + shortId;
const rootDir = comfyRoot.replace(/[\\/]+$/, '') + '/output/' + movie.slug + '/hyworld';
const mode = world.input_mode || 'text';
const seed = Math.floor(Math.random() * 2147483647);

try {
  // ================================================== video / multi-view
  //
  // World Reconstruction: WorldMirror 2.0 alone, which the docs say bypasses
  // panorama generation. Every setting is DOCUMENTATION.md's default for
  // WorldMirrorPipeline.__call__:
  //   target_size 952 · fps 1 · video_max_frames 32 · apply_sky_mask true ·
  //   apply_edge_mask true and edge thresholds 1.0 / 0.03, confidence mask off,
  //   confidence_percentile 10, voxel 0.002 (the node hardcodes all of these to
  //   the documented values) · float32, since enable_bf16 defaults to false.
  // low_vram_mode is OFF: on, it forces head_compute_mode 'depth_only', which
  // skips the native 3DGS head - the gaussians.ply the docs describe. Splat
  // upsample is OFF for the same reason: the output is the model's own
  // Gaussians, not splats rebuilt from depth. No priors are supplied, so the
  // cameras are predicted.
  if (mode === 'video' || mode === 'images') {
    const plyOut = rootDir + '/' + workspaceName + '/gaussians.ply';
    const g = {};
    let imagesRef;
    if (mode === 'video') {
      if (!world.source_path) return await fail('This world has no video to reconstruct.');
      const srcAbs = path.join(comfyRoot, String(world.source_path).split(BS).join('/'));
      if (!fs.existsSync(srcAbs)) return await fail('The video is missing on disk: ' + world.source_path);
      // fps 1, video_max_frames 32.
      g['video'] = {
        class_type: 'VHS_LoadVideoPath',
        inputs: {
          video: srcAbs, force_rate: 1, custom_width: 0, custom_height: 0,
          frame_load_cap: 32, skip_first_frames: 0, select_every_nth: 1
        }
      };
      imagesRef = ['video', 0];
    } else {
      // input_path as "a directory of images": several views of one place.
      const paths = Array.isArray(world.source_paths) ? world.source_paths.filter(Boolean) : [];
      if (paths.length < 2) return await fail('Multi-view reconstruction needs at least two pictures of the same place.');
      // One batch has one size, so ImageBatch scales each later view to the
      // first; WorldMirror then resizes and center-crops to target_size itself.
      for (let i = 0; i < paths.length; i++) {
        const staged = stage(paths[i], 'view_' + shortId + '_' + i);
        if (!staged) return await fail('A picture is missing on disk: ' + paths[i]);
        g['view' + i] = { class_type: 'LoadImage', inputs: { image: staged } };
        if (i === 0) imagesRef = ['view0', 0];
        else {
          g['batch' + i] = { class_type: 'ImageBatch', inputs: { image1: imagesRef, image2: ['view' + i, 0] } };
          imagesRef = ['batch' + i, 0];
        }
      }
    }
    g['wm'] = { class_type: 'VNCCS_LoadWorldMirrorV2Model', inputs: { device: 'cuda', precision: 'float32' } };
    g['recon'] = {
      class_type: 'VNCCS_WorldMirrorV2_3D',
      inputs: {
        model: ['wm', 0], images: imagesRef, target_size: 952,
        offload_scheme: 'none', low_vram_mode: false, apply_sky_mask: true, debug_log: false,
        enable_splat_upsample: false, splat_camera_source: 'predicted'
      }
    };
    // SavePLY keeps only the basename of `filename` and always writes to the
    // output root with a counter (output/<name>_00001_gaussians.ply). It returns
    // the full path it wrote, so that is moved to where the row says it is.
    g['save'] = { class_type: 'VNCCS_SavePLY', inputs: { ply_data: ['recon', 0], filename: workspaceName } };
    g['place'] = { class_type: 'RenameFile', inputs: { source_path: ['save', 0], dest_path: plyOut } };
    const recRec = await run(g, 240, 'WorldMirror reconstruction');
    const placed = JSON.stringify((recRec.outputs && recRec.outputs.place) || '');
    if (placed.indexOf('RENAME FAILED') >= 0) throw new Error('The splat was saved but could not be moved into place: ' + placed.slice(0, 400));
    await update({ status: 'complete', workspace_name: workspaceName, ply_path: plyOut, error_message: null });
    return { action: 'complete', mode: mode, worldId: world.id, plyPath: plyOut, workspaceName: workspaceName };
  }

  // ============================================ 1. HY-Pano 2.0 (internal)
  //
  // HY-Pano-2-Qwen, as DOCUMENTATION.md specifies it (Backend 2):
  // base Qwen/Qwen-Image-Edit-2509 + tencent/HY-World-2.0 HY-Pano-2.0
  // pytorch_lora_weights.safetensors, 40 steps, guidance_scale 1.0,
  // 1952 x 960, blend_width 32. It takes an `image` because it OUTPAINTS the
  // 360 into a wide canvas: for text that canvas is blank, for an image it is
  // that image. Either way the operator supplies no panorama.
  const PANO_W = 1952;
  const PANO_H = 960;
  const scenePrompt = String(world.prompt || '').trim() || 'a clean bright indoor scene';

  let canvasNode;
  if (mode === 'image') {
    if (!world.source_path) return await fail('This world has no source image.');
    const staged = stage(world.source_path, 'src_' + shortId);
    if (!staged) return await fail('The source image is missing on disk: ' + world.source_path);
    canvasNode = { class_type: 'LoadImage', inputs: { image: staged } };
  } else {
    canvasNode = { class_type: 'EmptyImage', inputs: { width: PANO_W, height: PANO_H, batch_size: 1, color: 0 } };
  }

  const flatPano = movie.slug + '_hyworld_' + shortId + '.png';
  const panoGraph = {
    '1': { class_type: 'UNETLoader', inputs: { unet_name: 'Qwen-Image-Edit-2509_fp8_e4m3fn.safetensors', weight_dtype: 'default' } },
    '2': { class_type: 'LoraLoaderModelOnly', inputs: { model: ['1', 0], lora_name: 'HY-Pano-2.0-Qwen_pytorch_lora_weights.safetensors', strength_model: 1 } },
    '3': { class_type: 'CLIPLoader', inputs: { clip_name: 'qwen' + BS + 'qwen_2.5_vl_7b.safetensors', type: 'qwen_image', device: 'default' } },
    '4': { class_type: 'VAELoader', inputs: { vae_name: 'qwen-image' + BS + 'qwen_image_vae.safetensors' } },
    '5': canvasNode,
    // use_official_prompt lets HY-Pano apply its own scaffolding instead of us
    // hand-writing panorama boilerplate around the description.
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
        image: ['6', 1], // wide_canvas_image: the canvas it outpaints into
        prompt: scenePrompt, width: PANO_W, height: PANO_H, seed: seed,
        steps: 40, cfg: 1, sampler_name: 'euler', scheduler: 'simple', denoise: 1,
        blend_width: 32, crop_border: 0, ref_latents_method: 'index',
        use_official_prompt: true, crop_right_edge: true
      }
    },
    // No separate seam-blend node: Generate already runs the circular edge
    // blend (blend_width 32, crop_right_edge) - a second pass cropped another
    // 32 px, 1888 wide instead of the documented 1920 x 960.
    '9': { class_type: 'SaveImage', inputs: { images: ['7', 0], filename_prefix: movie.slug + '/hyworld/' + workspaceName + '/pano' } },
    '10': { class_type: 'JWImageSaveToPath', inputs: { image: ['7', 0], path: comfyRoot.replace(/[\\/]+$/, '') + '/input/' + flatPano, overwrite: 'true' } }
  };

  const panoRec = await run(panoGraph, 180, 'HY-Pano');
  const panoRel = firstImage(panoRec);
  if (!panoRel) throw new Error('HY-Pano ran but produced no panorama.');
  await update({ pano_path: 'output/' + panoRel, workspace_name: workspaceName });

  // ================================== 2-5. WorldNav -> WorldStereo -> 3DGS
  const plyPath = rootDir + '/' + workspaceName + '/gs_results/ply/' + workspaceName + '_point_cloud_5000.ply';

  const worldGraph = {
    // The panorama comes back in from input/ by name.
    'pano': { class_type: 'LoadImage', inputs: { image: flatPano } },
    'ws': {
      class_type: 'HYWorld2Workspace',
      inputs: {
        workspace_name: workspaceName, root_dir: rootDir, scene_dir: '',
        panorama: ['pano', 0], scene_type: 'unknown', result_name: 'worldstereo-memory-dmd'
      }
    },
    // 2. WorldNav: VLM-guided trajectory planning.
    'traj': {
      class_type: 'HYWorld2Trajectories',
      inputs: {
        workspace: ['ws', 0], seed: 1, scene_type: 'auto',
        additional_nav_traj: false, extreme_detail_traj: false, detail_object_limit: 6,
        qwen_model_id: 'Qwen3-VL-4B-Instruct', qwen_quantization: '4-bit (VRAM-friendly)',
        qwen_max_image_edge: 768, apply_anchor_scan: false, anchor_scan_topk: 2
      }
    },
    'bank': {
      class_type: 'HYWorld2MemoryBank',
      inputs: {
        workspace: ['ws', 0], trajectory_set: ['traj', 0], image_width: 0, image_height: 0,
        nframe: 0, max_reference: 8, align_nframe: 8, downsampled_pts: 2000000,
        kb_anomaly_percentile: 90
      }
    },
    // 3. WorldStereo 2.0: keyframes with memory-guided consistency.
    'stereo': {
      class_type: 'VNCCS_LoadWorldStereoLightModel',
      inputs: { model: 'Memory DMD Light INT4', offload_mode: 'sequential_cpu_offload', device: 'cuda' }
    },
    'expand': {
      class_type: 'HYWorld2WorldExpansion',
      inputs: {
        workspace: ['ws', 0], memory_bank: ['bank', 0], trajectory_set: ['traj', 0],
        model: ['stereo', 0], qwen_model_id: 'Qwen3-VL-4B-Instruct',
        qwen_quantization: '4-bit (VRAM-friendly)', qwen_attention_mode: 'auto',
        // 512, as in the node's own "World Generation Full" workflow.
        qwen_max_image_edge: 768, qwen_max_new_tokens: 512, qwen_keep_model_loaded: true,
        qwen_frame_count: 4, seed: 1, max_trajectories: 0
      }
    },
    // 4. WorldMirror 2.0: depth, normals, cameras, points and 3DGS attributes.
    'batch': { class_type: 'HYWorld2PrepareWorldMirrorBatch', inputs: { memory_bank: ['expand', 0] } },
    'wm': { class_type: 'VNCCS_LoadWorldMirrorV2Model', inputs: { device: 'cuda', precision: 'fp8' } },
    'mirror': {
      class_type: 'VNCCS_WorldMirrorV2_3D',
      inputs: {
        model: ['wm', 0], images: ['batch', 0],
        camera_poses: ['batch', 1], camera_intrinsics: ['batch', 2],
        target_size: 840, offload_scheme: 'none', low_vram_mode: true,
        apply_sky_mask: false, debug_log: false, enable_splat_upsample: true,
        splat_upsample_scale: 0.003, splat_upsample_scale_mode: 'depth_adaptive',
        splat_upsample_depth_scale_strength: 1, splat_upsample_depth_scale_max: 3,
        splat_upsample_voxel_prune: true, splat_upsample_voxel_size: 0.0015,
        splat_upsample_max_points: 5000000, splat_upsample_cap_far_bias: 1.75,
        // Poses come from the batch, so they are used rather than predicted.
        splat_camera_source: 'camera_inputs'
      }
    },
    'align': {
      class_type: 'HYWorld2MemoryAlignment',
      inputs: {
        worldmirror_batch: ['batch', 3], raw_splats: ['mirror', 5], ply_data: ['mirror', 0],
        mode: 'align_and_export', downsampled_pts: 2000000, debug_mode: false
      }
    },
    // 5. 3DGS: the persistent, editable asset.
    'gsdata': {
      class_type: 'HYWorld2GSData',
      inputs: {
        workspace: ['ws', 0], memory_bank: ['align', 0], mode: 'build',
        result_name: 'worldstereo-memory-dmd', out_name: 'gs_data',
        save_normal: true, split_sky: true, split_align: false
      }
    },
    'train': {
      class_type: 'HYWorld2Train3DGS',
      inputs: {
        gs_data: ['gsdata', 0], train_sampling_preset: 'standard', batch_size: 1,
        patch_size: 'Full', max_steps: 5001, save_steps: '5001', eval_steps: '5001',
        ply_steps: '5001', downsample_pts_num: 2000001, save_ply: true,
        disable_video: true, disable_viewer: true, depth_loss: true, normal_loss: true,
        sky_depth_from_pcd: false, use_scale_regularization: true, use_mask_gaussian: true,
        mask_export_stochastic: true, mask_export_anchor_protection: false,
        use_anchor_protection: true, do_prune: false, prune_opacity_threshold: 0.01,
        antialiased: true, normalize_world_space: true, export_mesh: true,
        strategy_refine_start_iter: 150, strategy_refine_stop_iter: 750,
        strategy_refine_every: 100, strategy_refine_scale2d_stop_iter: 750,
        strategy_reset_every: 99990, strategy_grow_grad2d: 0.0001,
        strategy_prune_scale3d: 0.1, convert_ply_to_worldmirror_preview_basis: false
      }
    },
    'rename': { class_type: 'RenameFile', inputs: { source_path: ['train', 0], dest_path: plyPath } }
  };

  // 5001 training steps: an hour of headroom.
  await run(worldGraph, 720, 'World build');
  await update({ status: 'complete', ply_path: plyPath, error_message: null });

  return {
    action: 'complete',
    mode: mode,
    worldId: world.id,
    name: world.name,
    workspaceName: workspaceName,
    panoPath: 'output/' + panoRel,
    plyPath: plyPath
  };
} catch (e) {
  return await fail(e && e.message ? e.message : String(e));
}
