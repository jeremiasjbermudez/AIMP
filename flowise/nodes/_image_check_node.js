// 44-Image-Check: does this picture show what was asked for?
//
// A render either matches the prompt or it does not, and the only way to know
// has been to look. That is fine for one picture and useless across forty, which
// is how a plan ends up half full of frames nobody checked.
//
// So the same vision model that reads frames for the continuity pass is pointed
// at one picture and one prompt, and asked the narrow version of the question.
//
// WHAT IT IS NOT: a judge of quality. It cannot tell you a composition is dull
// or a face is uncanny, and asking it to would produce confident nonsense. It
// answers one thing - is what the prompt asked for actually in the picture - and
// the caller decides what to do about it.
//
// Input:  {"imagePath":"output/...","prompt":"...","strict":false}
// Output: {"action":"checked","ok":true,"why":"","missing":[...]}
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const insforgeUrl = $insforgeUrl;
const insforgeApiKey = $insforgeApiKey;
const comfyUrl = $comfyUrl;
// ---------------------------------------------------------------- language model
// Set once at install time and injected into every flow, so local and hosted
// models are the same switch rather than a code change.
//
//   $llmProvider  'ollama' for a local Ollama, 'openai' for anything that
//                 speaks the OpenAI chat-completions API - OpenAI itself,
//                 OpenRouter, Together, vLLM, LM Studio, llama.cpp
//   $llmUrl       its base URL, no trailing path
//   $llmModel     the model name that provider knows
//   $llmApiKey    sent as a bearer token; empty for a local server
// What was chosen at install time. Used when the app has not been given a
// choice of its own, which is the case on a fresh install.
const llmInstalled = {
  provider: ($llmProvider || 'ollama').toLowerCase(),
  url: String($llmUrl || '').replace(/\/$/, ''),
  model: $llmModel,
  apiKey: $llmApiKey || ''
};

// The old names, kept so nothing that reads them has to change. They describe
// the INSTALLED model; llmSettings() below is what a call actually uses.
const ollamaUrl = llmInstalled.url;
const ollamaModel = llmInstalled.model;

// Read once per invocation. A flow that makes four model calls should not ask
// four times, and the answer cannot change mid-run anyway.
let _llmCache = null;

/**
 * The model this call should use.
 *
 * The app writes its choice to app_settings, so changing model is a click
 * rather than a re-install. A missing row, an unreadable one or a profile that
 * has been deleted all fall back to the installed settings: a flow should not
 * stop working because a preference could not be read.
 */
async function llmSettings() {
  if (_llmCache) return _llmCache;
  _llmCache = llmInstalled;
  try {
    const axios = require('axios');
    const res = await axios.get(insforgeUrl + '/api/database/records/app_settings', {
      params: { key: 'eq.llm', select: 'value' },
      headers: { Authorization: 'Bearer ' + insforgeApiKey },
      timeout: 5000
    });
    const value = ((res.data || [])[0] || {}).value;
    const chosen = (value && (value.profiles || []).filter(function (p) { return p.id === value.selected; })[0]) || null;
    if (chosen && chosen.url) {
      _llmCache = {
        provider: String(chosen.provider || 'ollama').toLowerCase(),
        url: String(chosen.url).replace(/\/$/, ''),
        model: chosen.model,
        apiKey: chosen.apiKey || ''
      };
    }
  } catch (e) {
    // Left on the installed settings on purpose.
  }
  return _llmCache;
}

/**
 * One chat call, in Ollama's request and response shape, against either provider.
 *
 * Returning the Ollama shape is deliberate: every caller already reads
 * res.data.message.content, and translating the response here means none of
 * them had to be touched beyond the call itself.
 */
async function llmChat(body, options) {
  const axios = require('axios');
  const opts = Object.assign({ timeout: 300000 }, options || {});
  const cfg = await llmSettings();
  if (!cfg.url) {
    throw new Error('No language model is configured. Choose one at the top of the admin app, or re-run install/core/02-settings.ps1.');
  }
  // The chosen model wins over whatever the caller hardcoded, so switching
  // model in the app changes every flow rather than only the ones that ask.
  body = Object.assign({}, body, { model: cfg.model || body.model });

  if (cfg.provider === 'ollama') {
    let res = await axios.post(cfg.url + '/api/chat', body, opts);
    if (!llmContentOf(res)) {
      // Empty happens intermittently, usually on a reasoning model that spent
      // its budget thinking. One more ask is cheaper than failing the job.
      res = await axios.post(cfg.url + '/api/chat', body, opts);
    }
    llmRequireContent(res, cfg, body);
    return res;
  }

  // OpenAI-compatible. Ollama's extras have no equivalent and are dropped
  // rather than sent, because some servers reject unknown fields outright.
  const messages = (body.messages || []).map(function (m) {
    if (!m.images || !m.images.length) return { role: m.role, content: m.content };
    // Vision: Ollama takes bare base64 alongside the text, OpenAI takes parts.
    const parts = [{ type: 'text', text: m.content }];
    m.images.forEach(function (b64) {
      parts.push({ type: 'image_url', image_url: { url: 'data:image/png;base64,' + b64 } });
    });
    return { role: m.role, content: parts };
  });

  const payload = { model: body.model || cfg.model, messages: messages, stream: false };
  if (body.options && typeof body.options.temperature === 'number') {
    payload.temperature = body.options.temperature;
  }
  // Ollama's format:'json' is response_format here. num_ctx has no equivalent:
  // a hosted model's context is whatever it is.
  if (body.format === 'json') payload.response_format = { type: 'json_object' };

  const headers = Object.assign({ 'Content-Type': 'application/json' }, opts.headers || {});
  if (cfg.apiKey) headers.Authorization = 'Bearer ' + cfg.apiKey;

  const res = await axios.post(cfg.url + '/v1/chat/completions', payload,
    Object.assign({}, opts, { headers: headers }));
  llmRequireContent(res, cfg, body);
  const choice = (res.data && res.data.choices && res.data.choices[0]) || {};
  const content = (choice.message && choice.message.content) || '';
  // Shaped like Ollama's reply so callers need no branch of their own.
  return { data: { message: { content: content }, done: true, _raw: res.data } };
}
/** The text of a reply, in either provider's shape. */
function llmContentOf(res) {
  const d = (res && res.data) || {};
  const fromOllama = d.message && d.message.content;
  const fromApi = d.choices && d.choices[0] && d.choices[0].message && d.choices[0].message.content;
  return String(fromOllama || fromApi || '').trim();
}

/**
 * Refuse an empty reply, with enough detail to tell why.
 *
 * Callers parse the content as JSON. An empty string fails as "Unexpected end
 * of JSON input", which names neither the model nor the reason, and sends
 * whoever reads it looking in the wrong place.
 */
function llmRequireContent(res, cfg, body) {
  if (llmContentOf(res)) return;
  const d = (res && res.data) || {};
  const thinking = ((d.message && d.message.thinking) || '').length;
  const why = d.done_reason || (d.choices && d.choices[0] && d.choices[0].finish_reason) || 'unknown';
  const asked = (body.messages || []).reduce(function (n, m) { return n + String(m.content || '').length; }, 0);
  throw new Error(
    'The model returned an empty reply, twice. model=' + (cfg.model || '?') +
    ' at ' + cfg.url + ', stopped because: ' + why +
    (thinking ? ', and it returned ' + thinking + ' characters of reasoning instead of an answer' : '') +
    ', prompt was ' + asked + ' characters. ' +
    'A reasoning model can spend its whole budget thinking: try a larger context, ' +
    'a shorter input, or a different model in the picker at the top of the app.'
  );
}
// ---------------------------------------------------------------------------
let parsed;
try {
  parsed = JSON.parse(($flow.input || '').toString());
} catch (e) {
  return { error: 'Expected JSON {"imagePath":"output/...","prompt":"..."}' };
}
const imagePath = String(parsed.imagePath || '').trim();
const prompt = String(parsed.prompt || '').trim();
if (!imagePath) return { error: 'Give the path of the picture to check.' };
if (!prompt) return { error: 'Give the prompt it was rendered from.' };

// Read from ComfyUI's own folder rather than over HTTP: the file is on this
// machine and a round trip through /view only adds a way to fail.
const COMFY_ROOT = 'C:/ComfyUI2';
let bytes;
try {
  const rel = String(imagePath).split('\\').join('/');
  bytes = fs.readFileSync(path.join(COMFY_ROOT, rel));
} catch (e) {
  return { error: 'Could not read that picture: ' + (e && e.message ? e.message : String(e)) };
}

// The prompt carries a style prefix, a camera line, a setting and reference
// notes. Asking "does the picture match all of this" invites a no on the parts a
// picture cannot show. What is being checked is the SUBJECT: who and what is in
// frame and what they are doing.
const q = [
  'You are checking whether a rendered picture shows what was asked for.',
  '',
  'This is what was asked for:',
  prompt.slice(0, 1800),
  '',
  'Rules for your answer:',
  '- Judge only what the prompt says should be IN THE PICTURE: the people, the objects, what they are',
  '  doing, and where they are. Ignore anything about camera, lens, lighting style, film stock, mood or',
  '  rendering style - a still cannot be wrong about those.',
  '- ok is false when something the prompt asks for is MISSING, when there is an obvious extra person or',
  '  object that was never asked for, or when someone is duplicated.',
  '- ok is false when a described thing is plainly the WRONG THING - a different kind of object, a',
  '  different colour of clothing, an adult where a child was asked for.',
  '- ok is TRUE when the picture shows what was asked for, even if details are small, partly hidden, or',
  '  less detailed than the words. A description is always more specific than a picture can be.',
  '- If you are unsure, answer ok: true. A false alarm costs a re-render of a picture that was fine.',
  '',
  'Return ONLY JSON: {"ok":true|false,"why":"one short sentence, only if ok is false","missing":["..."]}'
].join('\n');

let out;
try {
  const res = await llmChat(
    {
      model: ollamaModel,
      stream: false,
      think: false,
      // A reading, not an opinion.
      options: { temperature: 0.1 },
      format: 'json',
      messages: [{ role: 'user', content: q, images: [bytes.toString('base64')] }]
    },
    { timeout: 300000 }
  );
  out = JSON.parse(((res.data && res.data.message && res.data.message.content) || '').trim());
} catch (e) {
  // A check that cannot run must not be read as a failed picture: the caller
  // would re-render something that was never judged.
  return {
    error: 'The check could not run: ' + (e && e.message ? e.message : String(e)),
    ok: null
  };
}

return {
  action: 'checked',
  ok: out.ok !== false,
  why: String(out.why || '').trim(),
  missing: Array.isArray(out.missing) ? out.missing.filter(Boolean).map(String) : []
};
