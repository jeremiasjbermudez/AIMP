// Calling the render host's worker (pc-worker/aimp_worker.py) from a flow.
//
// Included with `// @include worker_jobs`. The worker does what has to happen
// on the render host - Blender renders for sets, starting the world ComfyUI -
// behind a token. Long work is a job: submitted, then polled until it is done.

/** One request to the worker. Never throws: the parsed body, or { error }. */
async function workerCall(method, route, body) {
  const axios = require('axios');
  const base = String($workerUrl || '').replace(/\/$/, '');
  if (!base) return { error: 'No render-host worker is configured (WORKER_URL in install.env).' };
  try {
    const res = await axios({
      method, url: base + route, data: body,
      headers: { Authorization: 'Bearer ' + $workerToken },
      timeout: 60000, validateStatus: () => true
    });
    if (res.status >= 400) return { error: (res.data && res.data.error) || ('worker answered HTTP ' + res.status) };
    return res.data || {};
  } catch (e) {
    return { error: 'The render-host worker did not answer: ' + e.message };
  }
}

/**
 * Submit a job and wait for it. Resolves { status: 'done', result, id } or
 * { status: 'error' | 'timeout', error, id }.
 */
async function workerJob(body, opts) {
  const o = Object.assign({ timeoutMs: 30 * 60 * 1000, everyMs: 3000 }, opts || {});
  const sub = await workerCall('post', '/blender/jobs', body);
  if (sub.error) return { status: 'error', error: sub.error };
  const deadline = Date.now() + o.timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, o.everyMs));
    const job = await workerCall('get', '/blender/jobs/' + sub.id);
    // A failed job's record carries its own `error`, so the status decides; an
    // error with no status is the call itself failing, which is worth a retry.
    // Checking `error` first once made every failed job look like a lost
    // connection, and the flow waited out its whole timeout on it.
    if (job.status === 'done') return { status: 'done', result: job.result, id: sub.id };
    if (job.status === 'error') return { status: 'error', error: job.error || 'the job failed', id: sub.id, log: job.log };
  }
  return { status: 'timeout', error: `Still running after ${Math.round(o.timeoutMs / 60000)} minutes.`, id: sub.id };
}
