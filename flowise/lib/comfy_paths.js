// Folders for the files a graph writes to a path.
//
// Included with `// @include comfy_paths`. JWImageSaveToPath and RenameFile
// write to the exact path they are given and do not create its folder, so the
// first panorama of a new project failed with "[WinError 3] The system cannot
// find the path specified: ...\input\<project>\panos" - on the machine this
// was built on, those folders simply already existed.
//
// Call ensureSaveDirs(graph) before submitting a graph. It creates the parent
// folder of every path those nodes write to. That works when Flowise runs on
// the ComfyUI machine; elsewhere the paths are not on this disk, so it does
// nothing and the graph behaves as before.
const COMFY_PATH_WRITERS = { JWImageSaveToPath: 'path', RenameFile: 'dest_path' };

function ensureSaveDirs(graph) {
  const fs = require('fs');
  const path = require('path');
  for (const node of Object.values(graph || {})) {
    const key = node && COMFY_PATH_WRITERS[node.class_type];
    const target = key && node.inputs && node.inputs[key];
    // A wired input ([nodeId, slot]) is only known when the graph runs.
    if (typeof target !== 'string' || !target) continue;
    const dir = path.dirname(target);
    try {
      if (path.isAbsolute(dir) && !fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    } catch (e) {
      // Not this machine's disk, or not ours to create: the graph reports it.
    }
  }
}
