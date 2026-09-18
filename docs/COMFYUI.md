# ComfyUI: the graphs, and what they need

There are no saved workflow files to import here, by design. **Every graph this pipeline runs is
built in code**, inside the Flowise flow that runs it, and submitted to ComfyUI's API as JSON. A
flow reads its parameters from a database row, assembles a graph object, POSTs it to `/prompt`,
polls `/history/<id>`, then writes the output path back to the row.

That is why `flowise/nodes/*.js` is the authoritative reference for the graphs: the graph literal
is right there in the source, a plain object of `{ nodeId: { class_type, inputs } }`. Reading one
of those files tells you exactly which nodes, in which order, with which settings.

One exception: the shot-context flow loads a template workflow that ships with a third-party node
pack and patches it, rather than building from nothing. That template belongs to the pack and is
not redistributed here.

---

## Node packs required

The graphs use **85 distinct node classes**. 55 are ComfyUI core. The rest come from these packs,
all of which must be installed before any flow will run:

| Pack | Classes used | What for |
|---|---|---|
| `ComfyUI_HYWorld2` | `HYWorld2Workspace`, `HYWorld2Trajectories`, `HYWorld2MemoryBank`, `HYWorld2WorldExpansion`, `HYWorld2PrepareWorldMirrorBatch`, `HYWorld2MemoryAlignment`, `HYWorld2GSData`, `HYWorld2Train3DGS`, `HYWorld2QwenPanoGenerate`, `HYWorld2QwenPanoEncoder`, `HYWorld2QwenPanoSeamBlend`, `VNCCS_LoadWorldStereoLightModel`, `VNCCS_LoadWorldMirrorV2Model`, `VNCCS_WorldMirrorV2_3D`, `VNCCS_BackgroundPreview`, `VNCCS_SavePLY` | the entire 3D world pipeline: panorama to explored world to trained Gaussian splat |
| `comfyui_segment_anything` | `GroundingDinoModelLoader`, `GroundingDinoSAMSegment`, `SAMModelLoader` | text-prompted masking, used by the face repaint |
| `comfyui-videohelpersuite` | `VHS_LoadVideoPath` | loading a video file from an absolute path as a frame batch |
| `comfyui-various` | `JWImageLoadRGB`, `JWImageSaveToPath` | reading and writing an image at an exact path |
| `comfyui-kjnodes` | `PathchSageAttentionKJ` | attention speed-up on the video model |
| `comfyui-rename-file` | `RenameFile` | moving a finished render to its final name inside a graph |
| `panorama-stickers` | `PanoramaStickers` | compositing onto an equirectangular panorama |
| `ComfyUI-Spectrum-MiniMax-H3` | `SpectrumApplyMiniMaxH3` | optional video acceleration |
| `ComfyUI-MiniMaxH3-Context-Loop` | `MiniMaxH3TaggedPictureReference` | tagged multi-reference conditioning, plus the one template workflow |
| `ComfyUI-H3-FunControl` | `H3FunControlLoader`, `H3FunControlApply` | driving video generation from a depth / pose / edge control video |
| `ComfyUI-H3-Motion-Context-MultiRef` | `TrimAudioDuration` | trimming generated audio to length |

Installing the pack is not enough on its own — each one has its own model downloads. See
[MODELS.md](MODELS.md).

---

## The graphs, by flow

Each row is one graph, built in the named source file. "Nodes" is the count of distinct node
classes in that graph.

| Built in | Nodes | What the graph does |
|---|---|---|
| `_world_builder_node.js` | 16 | panorama → workspace → planned camera trajectories → invented views → reconstruction → training data → trained Gaussian splat, ending in a rename to the final file |
| `_hyworld_node.js` | 25 | the same world pipeline driven from text, an image or a video instead of a project scene |
| `_prompt_world_node.js` | 24 | a world from a text description alone, panorama generated first |
| `_minimax_av_node.js` | 18 | video and audio from a first frame, optionally a last frame, or from text alone |
| `_minimax_ref_node.js` | 14 | video from reference images that persist on every frame |
| `_minimax_v2v_node.js` | 15 | video from an existing clip plus references: the source carries the performance |
| `_minimax_control_node.js` | 18 | video driven frame-by-frame by a depth / pose / edge control video |
| `_minimax_extend_node.js` | 22 | continuing an existing clip from its own last frames |
| `_director_node.js` | 2 | per-shot generation using a tagged multi-reference template |
| `_image_edit_node.js` | 18 | multi-reference image editing |
| `_character_qa_shots_node.js` | 18 | a set of fixed camera angles of one subject, for checking identity |
| `_face_fix_node.js` | 17 | detect a face, mask it, repaint only inside the mask |
| `_qwen_cleanup_node.js` | 14 | correcting a rough render against a clean reference |
| `_qwen_image_edit_node.js` | 8 | single-model image editing |
| `_z_image_node.js` | 10 | fast image generation |
| `_panoramic_generator_node.js` | 12 | a 360° equirectangular panorama of a location |
| `_score_node.js` | 18 | music generation, two model families, with an optional reference timbre |

---

## Conventions every graph follows

- **Paths.** Inputs are read from `input/`, outputs written to `output/<project>/<feature>/`. The
  database stores those relative paths; the browser turns them into `/view` URLs.
- **Staging.** A graph's image loader only reads from `input/`. Flows copy anything that lives in
  object storage or under `output/` into `input/` first, then pass the relative name.
- **Waiting.** Flows poll `/history/<prompt_id>` on a fixed interval with a bounded number of
  attempts, and return a `pending` result rather than blocking forever if the render outlives the
  window.
- **Failures.** A rejected graph comes back as HTTP 400 with the offending node named. Flows catch
  that and write the message to the row's error column, because an uncaught rejection would leave
  the row stuck at `rendering` with nothing to debug from.
- **VRAM.** Before a large build, a flow may call `POST /free` to unload models. Two heavy graphs
  at once will fail on memory.
