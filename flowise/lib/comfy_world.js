// Where HY-World graphs run.
//
// Included with `// @include comfy_world`. HY-World 2 needs a Python
// environment the main ComfyUI cannot share, so on a render host set up that
// way its graphs run on a second, on-demand ComfyUI. The render host's worker
// (pc-worker/aimp_worker.py) starts it - after the main one has unloaded its
// models - and stops it again once it has been idle. This asks for it and
// returns its address, waiting while it starts.
//
// With no worker configured ($workerUrl blank) the main ComfyUI is used, which
// is right for an install where one environment has HY-World in it.
async function worldComfyUrl() {
  const worker = String($workerUrl || '').replace(/\/$/, '');
  if (!worker) return $comfyUrl;
  const axios = require('axios');
  let res;
  try {
    res = await axios.post(worker + '/world/start', {}, {
      headers: { Authorization: 'Bearer ' + $workerToken },
      // Starting it loads a large environment; the worker waits up to five
      // minutes for it to answer before giving up.
      timeout: 360000,
      validateStatus: () => true
    });
  } catch (e) {
    throw new Error('The render host worker at ' + worker + ' did not answer: ' + e.message);
  }
  if (res.status !== 200 || !res.data || !res.data.url) {
    throw new Error('The render host could not start the world ComfyUI: ' + JSON.stringify(res.data).slice(0, 400));
  }
  return String(res.data.url).replace(/\/$/, '');
}
