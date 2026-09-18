# Model Inventory

Everything the generation pipeline loads, where it goes, and what calls it.

The pipeline is a set of Flowise custom-function nodes (`_*.js`) that build ComfyUI API
graphs and POST them to a local ComfyUI instance, plus an Ollama server used for all
text and vision-language work. The model set covers six jobs:

| Job | Stack |
|---|---|
| Video generation (with synchronised audio) | MiniMax H3 (fl2va / ref2va / Fun ControlNet) |
| Image generation and editing | FLUX.2 Klein 9B, Qwen-Image-Edit 2509/2511, Z-Image Turbo |
| 3D world generation | HY-World 2.0 — WorldStereo Light + WorldMirror 2.0 |
| Music / score generation | ACE-Step 1.5, MiniMax Music 3 |
| Masking, face work, upscaling | GroundingDINO + SAM-HQ, InsightFace, Real-ESRGAN |
| Text and vision-language | Ollama (separate host, see below) |

**Model root:** `C:\ComfyUI2\models`. Paths in the tables below are relative to that root.
Sizes are GiB as reported on disk.

A model is marked **in use** if a Flowise node source (`_*.js`) references it, either by
filename or by the loader's display name. Models that appear only in saved ComfyUI GUI
workflows, or nowhere at all, are listed under [Not currently referenced](#not-currently-referenced).

---

## 1. Video generation — MiniMax H3

Two separate base checkpoints. `fl2va` handles text/image/first-last-frame to video+audio;
`ref2va` handles reference-guided and video-to-video generation and is a *different*
checkpoint, not a LoRA on the first. Both share the encoder and the two VAEs.

Provenance: open weights on Hugging Face at `Comfy-Org/MiniMax-H3` (ComfyUI-packaged) and
`MiniMaxAI/MiniMax-H3` (source and docs). Open weights under the MiniMax H3 Community
License; check that repo's license Q&A before any commercial use.

| File | Size | Folder | Source | Used by |
|---|---|---|---|---|
| `minimax_h3_fl2va_pruned_int8_convrot.safetensors` | 19.53 | `diffusion_models` | `Comfy-Org/MiniMax-H3` | Image/Text-to-Video and Extend flows |
| `minimax_h3_ref2va_pruned_int8_convrot.safetensors` | 19.53 | `diffusion_models` | `Comfy-Org/MiniMax-H3` | Reference-to-Video, Video-to-Video, Control-to-Video flows |
| `qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors` | 14.61 | `text_encoders` | `Comfy-Org/MiniMax-H3` | every H3 flow — loaded via `CLIPLoader(type="minimax")` |
| `minimax_h3_video_vae_fp16.safetensors` | 4.85 | `vae` | `Comfy-Org/MiniMax-H3` | every H3 flow |
| `minimax_h3_audio_vae_fp32.safetensors` | 0.56 | `vae` | `Comfy-Org/MiniMax-H3` | every H3 flow — must stay fp32 |
| `minimax_h3_fun_controlnet_union_pruned_bf16.safetensors` | 3.93 | `controlnet` | Kijai re-derivation of Alibaba PAI `MiniMax-H3-Fun-Controlnet-Union` | Control-to-Video flow (depth / pose / canny / HED / MLSD). Requires the `ComfyUI-H3-FunControl` node pack; the original full-width checkpoint is rejected by it |
| `minimax_h3_turbo_v4_step600_ema_pruned_comfyui.safetensors` | 0.58 | `loras` | unknown | turbo step-reduction LoRA on the Image-to-Video and Extend flows |

**Subtotal: 63.6 GB.**

---

## 2. Image generation and editing

Three independent image stacks. FLUX.2 Klein 9B is the character/reference stack, Qwen-Image-Edit
is the editing and cleanup stack, and Z-Image Turbo is the fast generator.

### 2.1 FLUX.2 Klein 9B

| File | Size | Folder | Source | Used by |
|---|---|---|---|---|
| `flux-2-klein-9b.safetensors` | 16.91 | `diffusion_models` | unknown | character generator, reference shots, close-ups, inpaint, face fix, image edit, panoramic generator |
| `qwen_3_8b_fp8mixed.safetensors` | 8.07 | `text_encoders` | unknown | text encoder for every Klein graph |
| `flux2-vae.safetensors` | 0.31 | `vae` | unknown | every Klein graph |
| `flux-2-klein-9B-360-erp-outpaint-lora_V1.safetensors` | 0.08 | `loras` | unknown | panoramic generator — 360° equirectangular outpaint |
| `DH-Lora/*-klein.safetensors` (8 files, 0.154 each) | 1.23 | `loras/DH-Lora` | trained locally for this project — not downloadable | per-subject identity LoRAs applied on top of Klein for reference portraits. Two are wired into node code by filename; the rest are selected at runtime, the node reading the filename from the character record in the database |

### 2.2 Qwen-Image-Edit

| File | Size | Folder | Source | Used by |
|---|---|---|---|---|
| `qwen_image_edit_2511_bf16.safetensors` | 38.05 | `diffusion_models` | unknown | cleanup flow, inpaint, prompt-to-world panorama stage |
| `Qwen-Image-Edit-2509_fp8_e4m3fn.safetensors` | 19.03 | `diffusion_models` | unknown | HY-World panorama stage |
| `qwen/qwen_2.5_vl_7b.safetensors` | 15.45 | `text_encoders/qwen` | unknown | text encoder for every Qwen-Image-Edit graph (note the nested folder) |
| `qwen-image/qwen_image_vae.safetensors` | 0.24 | `vae/qwen-image` | unknown | every Qwen-Image-Edit graph (note the nested folder) |
| `Qwen-Rapid-AIO-NSFW-v23.safetensors` | 26.48 | `checkpoints` | unknown | standalone Qwen image-edit flow (all-in-one checkpoint, no separate encoder/VAE) |
| `Qwen-Image-2512-Lightning-4steps-V1.0-fp32.safetensors` | 1.58 | `loras` | unknown | cleanup flow — 4-step distillation |
| `Qwen-Image-Edit-2511-Lightning-4steps-V1.0-bf16.safetensors` | 0.79 | `loras` | unknown | inpaint flow — 4-step distillation |
| `Qwen-Image-Edit-F2P.safetensors` | 0.44 | `loras` | unknown | cleanup flow |
| `qwen-image-edit-2511-multiple-angles-lora.safetensors` | 0.27 | `loras` | unknown | inpaint flow — alternate camera angles |
| `Sharp.safetensors` | 0.22 | `loras` | unknown | cleanup flow |
| `HighDetail.safetensors` | 0.65 | `loras` | unknown | image edit and standalone Qwen edit flows |
| `HY-Pano-2.0-Qwen_pytorch_lora_weights.safetensors` | 0.79 | `loras` | HY-World 2.0 (`github.com/Tencent-Hunyuan/HY-World-2.0`) | HY-World panorama generation stage |
| `panorama-v2-qwen-image-2512_15.safetensors` | 0.22 | `loras` | unknown | prompt-to-world panorama stage |

### 2.3 Z-Image Turbo

| File | Size | Folder | Source | Used by |
|---|---|---|---|---|
| `z_image_turbo_bf16.safetensors` | 11.46 | `diffusion_models` | unknown | Z-Image flow |
| `qwen_3_4b.safetensors` | 7.49 | `text_encoders` | unknown | Z-Image text encoder |
| `ae.safetensors` | 0.31 | `vae` | unknown | Z-Image VAE |

**Subtotal: 150.1 GB** — 26.6 GB for Klein, 104.2 GB for Qwen-Image-Edit, 19.3 GB for Z-Image.

---

## 3. 3D world generation — HY-World 2.0

Panorama → WorldStereo keyframe expansion → WorldMirror reconstruction → 3D Gaussian splat.
Needs the `ComfyUI_HYWorld2` / VNCCS node pack. Reference docs:
[HY-World 2.0](https://github.com/Tencent-Hunyuan/HY-World-2.0),
[WorldMirror](https://github.com/Tencent-Hunyuan/HunyuanWorld-Mirror),
[WorldStereo](https://github.com/FuchengSu/WorldStereo).

These loaders select by dropdown label, not filename, so the files must sit at the exact
paths below.

| File | Size | Folder | Source | Used by |
|---|---|---|---|---|
| `HY-WorldMirror-2.0/model.safetensors` (+ `config.json`) | 4.71 | `WorldMirror-V2` | HunyuanWorld-Mirror | `VNCCS_LoadWorldMirrorV2Model` → depth, normals, camera poses, point cloud, splats in one pass |
| `vnccs-worldstereo-memory-dmd-int4.safetensors` (+ `.json`) | 8.39 | `WorldStereoLight` | WorldStereo, int4-quantised by the VNCCS pack | `VNCCS_LoadWorldStereoLightModel`, label **Memory DMD Light INT4** — the world-expansion model actually selected |
| `vnccs-worldstereo-camera-light-int4.safetensors` (+ `.json`) | 8.37 | `WorldStereoLight` | WorldStereo, int4-quantised by the VNCCS pack | same loader, label **Camera Light INT4** — the alternative. Optional |
| `WorldStereo_umt5-xxl-encoder-fp8.safetensors` | 6.27 | `clip` | unknown | text encoder for the WorldStereo stage (loaded implicitly by the pack) |
| `WorldStereo_wan_2.1_vae.safetensors` | 0.47 | `vae` | unknown | VAE for the WorldStereo stage (loaded implicitly by the pack) |
| `Qwen-VL/Qwen3-VL-4B-Instruct/` (2 shards + tokenizer) | 8.28 | `LLM` | `Qwen/Qwen3-VL-4B-Instruct` | referenced by `model_id` in the world-builder node for scene understanding |

**Subtotal: 36.5 GB** (28.1 GB if you skip the Camera Light variant).

> `models/WorldStereo/` holds an 18 KB stub only — the full-size WorldStereo weights were
> never downloaded. The full `worldstereo-memory-dmd` needs 40 GB+ VRAM; on a 32 GB card
> the int4 Light models above are the realistic ceiling. Do not download the full set unless
> the target box has the VRAM.

---

## 4. Music and score generation

Two alternative engines, selected per row by a `generator` field.

| File | Size | Folder | Source | Used by |
|---|---|---|---|---|
| `ace_step_1.5_turbo_aio.safetensors` | 9.34 | `checkpoints` | ACE-Step | score flow, `ace_step_15` (all-in-one turbo checkpoint) |
| `acestep_v1.5_xl_sft_bf16.safetensors` | 9.29 | `diffusion_models` | ACE-Step | score flow, `ace_step_15_xl` |
| `ace_1.5_vae.safetensors` | 0.31 | `vae` | ACE-Step | score flow, both ACE variants |
| `qwen_0.6b_ace15.safetensors` | 1.11 | `text_encoders` | ACE-Step | score flow — first of two CLIP inputs |
| `qwen_1.7b_ace15.safetensors` | 3.45 | `text_encoders` | ACE-Step | score flow — second CLIP input |
| `minimax_music3_dit_fp16.safetensors` | 4.58 | `diffusion_models` | MiniMax Music 3 | score flow, MiniMax engine |
| `minimax_music3_text_encoder_pruned_int8_convrot.safetensors` | 8.57 | `text_encoders` | MiniMax Music 3 | score flow, MiniMax engine |
| `minimax_music3_dav.safetensors` | 0.20 | `vae` | MiniMax Music 3 | score flow, MiniMax engine |

**Subtotal: 36.9 GB.** Either engine alone works; ACE is 23.5 GB, MiniMax Music is 13.4 GB.

---

## 5. Masking, face work and upscaling

Small utility models. Referenced by loader display name rather than by filename, so the
file must match the name the node pack expects.

| File | Size | Folder | Source | Used by |
|---|---|---|---|---|
| `groundingdino_swint_ogc.pth` | 0.65 | `grounding-dino` | GroundingDINO SwinT OGC | `GroundingDinoSAMSegment` — subject masking in inpaint, close-up and face-fix flows. Loader label: `GroundingDINO_SwinT_OGC (694MB)` |
| `sam_hq_vit_l.pth` | 1.17 | `sams` | SAM-HQ ViT-L | `SAMModelLoader (segment anything)`, paired with GroundingDINO. Loader label: `sam_hq_vit_l (1.25GB)` |
| `inswapper_128.onnx` | 0.52 | `insightface` | InsightFace | `ReActorFaceSwap` / `ReActorFaceSimilarity` in the inpaint flow |
| `models/buffalo_l/` (5 ONNX files) | 0.32 | `insightface` | InsightFace `buffalo_l` | required by the ReActor nodes above for detection and embedding |
| `RealESRGAN_x4plus.pth` | 0.06 | `upscale_models` | Real-ESRGAN | the enhance/upscale workflow builder |

The ReActor node also names `retinaface_resnet50` for detection; that one is fetched
automatically by facexlib on first run and is not in the model root. Face restoration in
the inpaint flow is set to `none`, so no GFPGAN/CodeFormer weights are needed.

**Subtotal: 2.7 GB.**

---

## 6. Ollama — text and vision-language

All screenplay, breakdown, description and vision-QA work runs against an Ollama server,
never through ComfyUI. Node sources read it as:

```js
const OLLAMA = process.env.OLLAMA_URL || 'http://<ollama-host>:11434';
```

Port **11434** is the Ollama default and is used unchanged. Some nodes point at
`http://127.0.0.1:11434` (Ollama running on the same box as ComfyUI) and others at a LAN
host; both were tested and either works. Set `OLLAMA_URL` rather than editing the sources.

| Ollama model | Role |
|---|---|
| `huihui_ai/Qwen3.8-abliterated:latest` | the default LLM for every generated Flowise flow — beat generation, character bible, wardrobe, panorama prompts, prompt enhancement, chat, scene import, score prompts, screenplay assist and writing |
| `qwen3.8:latest` | shot breakdown, screenplay-from-shots, descriptor synthesis, character generator rebuild. Same family as above, non-abliterated |
| `gemma4:12b` | vision-language yes/no QA gate in the inpaint and close-up flows — "is the subject present / correct" checks against a rendered frame |
| `qwen2.5vl:7b` | vision-language pass in the inpaint flow |
| `qwen2.5:32b` | text pass in the inpaint flow |

Pull these with `ollama pull <name>`. `huihui_ai/Qwen3.8-abliterated:latest` is a public
Ollama-registry model.

### Local conversion artifacts (not needed for a rebuild)

`models/LLM/Qwen3.8-27B/` (51.8 GB, 18 HF shards) and `models/LLM/Qwen3.8-27B-GGUF/`
(71.8 GB — a BF16 intermediate plus a Q6_K quant) are the local download-convert-quantize-push
chain that produced an Ollama model on this box. Nothing in the pipeline loads these files
directly. **A rebuilder should pull from the Ollama registry instead and skip all 123.6 GB.**

---

## Not currently referenced

Roughly **725 GB of the 1,015.7 GB** in the model root is not called by any pipeline node.
It splits into two groups.

### A. Referenced only in saved ComfyUI GUI workflows (~462 GB)

These appear in `ComfyUI/user/default/workflows/*.json` — hand-built experiments and earlier
iterations — but no Flowise node builds a graph that loads them. Skip them for a working
rebuild; restore selectively only if you also want the saved GUI workflows to open cleanly.

| Group | Approx. size | Notes |
|---|---|---|
| LTX-2 / LTX-2.3 / LTX-2.5 video stack — base checkpoints, distilled variants, transformer-only builds, text projection, video + audio VAEs, spatial upscalers, IC-LoRAs, tiny VAE, and its subject/motion LoRAs (45 files) | 240.5 GB | the previous video engine, superseded by MiniMax H3. Includes two identical 42.98 GB copies of the same dev checkpoint, one in `checkpoints` and one in `diffusion_models` |
| Gemma 3 / Gemma 4 text encoders, six quantisations (6 files) | 62.8 GB | LTX-era encoders |
| Krea 2 Turbo image model, three quantisations + one LoRA (4 files) | 37.6 GB | evaluated, not adopted |
| Alternate quantisations of models already in §1–§4 — a Klein GGUF, an fp8 Qwen 2.5-VL encoder, two copies of an fp8 Qwen3-VL-4B, ACE-Step v1 3.5B, CLIP-L, CLIP-Vision-H (8 files) | 36.6 GB | redundant with the files the pipeline actually loads |
| MiniMax H3 alternates — a ref2va Viggle-fused checkpoint plus Viggle / TaoMate / turbo / realism LoRAs (7 files) | 26.5 GB | the TaoMate 3-step adapter here was converted locally from the PEFT release at `github.com/TaoLiveAIGC/TaoMate-H3`; it is parked, not wired in |
| `Qwen-Rapid-AIO-SFW-v23.safetensors` | 26.5 GB | the SFW twin of the all-in-one checkpoint the pipeline does use |
| Hunyuan3D 2.1 multi-view DiT + VAE, TripoSplat, MoGe-2, Florence-2 (large and fine-tuned), SAM 3.1, DINOv3, BiRefNet, NSFW detector, YOLOv8 detectors, CodeFormer/GFPGAN, extra upscalers, InsightFace extras (22 files) | 16.2 GB | mesh and aux models from GUI experiments. Florence-2 in particular was deliberately migrated off — masking now goes through GroundingDINO + SAM-HQ |
| Wan 2.1 image encoder, VAEs, umt5-xxl encoder, LightX2V distill LoRAs (5 files) | 8.6 GB | Wan-era leftovers |
| Remaining subject-identity and effect LoRAs under `loras/`, `loras/archive/`, `loras/Those/`, `loras/MNw/`, `loras/ZIT/`, `loras/Promo/`, `loras/FK-Those/` (19 files) | 5.7 GB | not needed to run the pipeline |

### B. Referenced nowhere at all (~265 GB)

| File / group | Size | Folder | Notes |
|---|---|---|---|
| `LLM/Qwen3.8-27B/` + `LLM/Qwen3.8-27B-GGUF/` | 123.6 | `LLM` | Ollama conversion chain — see §6 |
| `wan2.1_14B_SCAIL_2_fp16.safetensors` | 30.54 | `diffusion_models` | orphan Wan 2.1 variant |
| `ApexQwenEdit2511_int8_convrot.safetensors` | 19.14 | `diffusion_models` | alternate Qwen-Image-Edit quantisation, never wired in |
| `qwen3vl_32b_h3_ultra_..._bf16.safetensors` | 14.16 | `text_encoders` | alternate H3 encoder, never wired in |
| `hunyuan3d-dit-v2-1.ckpt` (+ a `.ckpt.bad` partial), `hunyuan_3d_v2.1.safetensors` | 14.3 | `diffusion_models`, `checkpoints` | single-view Hunyuan3D; superseded by the HY-World path. The `.bad` file is a failed download — delete it |
| `sharp/sharp_2572gikvuh.pt` | 2.62 | `sharp` | unidentified; no node pack in this install loads from `models/sharp` |
| `depth_anything_3_mono_large` / `_small`, `MoGe/model.pt` | 2.6 | `geometry_estimation`, `MoGe` | depth estimators from GUI experiments |
| `groundingdino_swinb_cogcoor.pth` | 0.87 | `grounding-dino` | the larger GroundingDINO; the pipeline uses SwinT |
| Florence-2 `.bin` duplicates of the `.safetensors` weights, GFPGAN 1.3, GPEN-BFR-512, a person-segmentation YOLOv8, an orphan LTX-2.5 VAE | 4.9 | `LLM`, `facerestore_models`, `ultralytics`, `vae` | |
| 107 further LoRAs, largely duplicates of files in group A | 52.5 | `loras/**` | includes byte-identical copies of the same adapter under two folder names, and URL-encoded filenames left over from a bulk download |

Two duplicate pairs are worth flagging on a rebuild: `ltx-2.3-22b-dev.safetensors` exists
twice at 42.98 GB (86 GB total for one model), and several LoRAs exist byte-identically in
both `loras/` and `loras/archive/` or `loras/Those/`.

---

## Download order and disk budget

Total required for a working pipeline: **~290 GB.** Total currently on disk: **1,015.7 GB.**

Download in this order — each tier is independently runnable, so you can stop early and have
a working subset.

### Tier 1 — required core (197 GB)

Nothing runs without these.

1. **MiniMax H3 video, 63.6 GB** (§1) — all seven files. This is the pipeline's output stage.
2. **FLUX.2 Klein image stack, 26.6 GB** (§2.1) — base + encoder + VAE + the 360° LoRA.
   The per-subject `DH-Lora` identity adapters (1.2 GB of that) are project-trained and cannot be
   re-downloaded; without them the character flows still run but produce generic subjects.
3. **Qwen-Image-Edit stack, 104.2 GB** (§2.2) — both base checkpoints, the shared
   encoder/VAE, the all-in-one checkpoint, and all eight LoRAs. If disk is tight, the
   2511 base (38 GB) plus encoder/VAE covers the cleanup and inpaint flows; the 2509
   base is only needed for the HY-World panorama stage, and the AIO checkpoint only for
   the standalone edit flow.
4. **Masking and face utilities, 2.7 GB** (§5) — tiny, and the inpaint flow hard-fails
   without them.
5. **Ollama models** (§6) — pull over the network, they do not live in the ComfyUI model
   root. Budget ~40 GB on the Ollama host.

### Tier 2 — optional per feature (93 GB)

Each block is only needed if you want that feature.

| Feature | Size | Files |
|---|---|---|
| Fast image generation (Z-Image Turbo) | 19.3 GB | §2.3 (already counted inside §2's subtotal) |
| 3D world generation | 28.1 GB | §3, skipping the Camera Light variant |
| 3D world — Camera Light alternative | +8.4 GB | §3 |
| Score generation, ACE-Step engine | 23.5 GB | §4 |
| Score generation, MiniMax Music engine | 13.4 GB | §4 |

### Not to be downloaded

Everything in [Not currently referenced](#not-currently-referenced) — about 725 GB. That
includes the entire LTX video stack, the Gemma text encoders, the Krea 2 checkpoints and the
123.6 GB Ollama conversion chain. A rebuild that skips all of it loses no pipeline
functionality.

### VRAM note

The image set (Klein, ~27 GB) and the world set cannot be resident together on a 32 GB card;
switching between them costs a full model reload. Plan the two as separate passes rather
than one graph.
