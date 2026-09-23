// Submitting a graph to ComfyUI and following it to the end.
//
// Included with `// @include comfy_jobs`. What each flow did by hand, and where
// it went wrong:
// - ComfyUI rejects a bad graph with HTTP 400. axios throws on that, so the
//   "enqueue failed" branch after it never ran and the row stayed "running"
//   with no error at all.
// - A job ComfyUI has forgotten - it restarted, or the job was deleted from the
//   queue - is in neither its queue nor its history. The loops polled history
//   only, waited out their whole window (40 minutes, 4 hours) and then reported
//   "still running", so the row stayed "running" for good.
// - Failures came back as raw status JSON.

/** Queue a graph. Never throws: { promptId } or { error } in ComfyUI's own words. */
async function comfySubmit(baseUrl, graph) {
  const axios = require('axios');
  let res;
  try {
    res = await axios.post(String(baseUrl).replace(/\/$/, '') + '/prompt', { prompt: graph },
      { validateStatus: () => true, timeout: 60000 });
  } catch (e) {
    return { error: 'ComfyUI did not answer at ' + baseUrl + ': ' + e.message };
  }
  const data = res.data || {};
  if (res.status === 200 && data.prompt_id) return { promptId: data.prompt_id };
  const parts = [];
  if (data.error) parts.push(data.error.message + (data.error.details ? ' - ' + data.error.details : ''));
  for (const [id, ne] of Object.entries(data.node_errors || {})) {
    for (const err of ne.errors || []) {
      parts.push(`node ${id} (${ne.class_type}): ${err.message}${err.details ? ' - ' + err.details : ''}`);
    }
  }
  return { error: 'ComfyUI rejected the graph (HTTP ' + res.status + '): ' + (parts.join('; ') || JSON.stringify(data).slice(0, 600)) };
}

/** One readable line from a failed history record. */
function comfyErrorText(record) {
  const messages = (record && record.status && record.status.messages) || [];
  const err = messages.find((m) => m[0] === 'execution_error');
  if (err) {
    const e = err[1] || {};
    return `${e.node_type || 'a node'} (node ${e.node_id}) failed: ${e.exception_message || e.exception_type || 'no message'}`.trim();
  }
  const interrupted = messages.find((m) => m[0] === 'execution_interrupted');
  if (interrupted) return 'The job was interrupted in ComfyUI.';
  return 'ComfyUI reported an error: ' + JSON.stringify(messages).slice(0, 600);
}

/**
 * Follow a queued job until it finishes, fails, or turns out to be gone.
 * Resolves { status: 'success' | 'error' | 'lost' | 'timeout', record, error }.
 * 'lost': in neither the queue nor the history on two checks in a row, which is
 * what a ComfyUI restart looks like.
 */
async function comfyWait(baseUrl, promptId, opts) {
  const axios = require('axios');
  const base = String(baseUrl).replace(/\/$/, '');
  const o = Object.assign({ timeoutMs: 40 * 60 * 1000, everyMs: 5000 }, opts || {});
  const deadline = Date.now() + o.timeoutMs;
  let missing = 0;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, o.everyMs));
    let record = null;
    try {
      const h = await axios.get(base + '/history/' + promptId, { timeout: 15000 });
      record = h.data && h.data[promptId];
    } catch (e) {
      continue; // ComfyUI busy or restarting; the queue check below decides
    }
    if (record && record.status && record.status.status_str) {
      return record.status.status_str === 'success'
        ? { status: 'success', record }
        : { status: 'error', record, error: comfyErrorText(record) };
    }
    try {
      const q = (await axios.get(base + '/queue', { timeout: 15000 })).data || {};
      const queued = [...(q.queue_running || []), ...(q.queue_pending || [])].some((item) => item[1] === promptId);
      missing = queued ? 0 : missing + 1;
    } catch (e) {
      continue;
    }
    if (missing >= 2) {
      return { status: 'lost', error: 'ComfyUI no longer has this job (it may have restarted, or the job was deleted from its queue). Run it again.' };
    }
  }
  return { status: 'timeout', error: `Still running after ${Math.round(o.timeoutMs / 60000)} minutes.` };
}
