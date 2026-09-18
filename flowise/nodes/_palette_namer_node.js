// Names a colour palette and writes the grading note for it.
//
// The swatches arrive already measured - the app quantises the image's own
// pixels in the browser, so they are exact. This node is deliberately NOT asked
// for hex values: a vision model asked to read colours off a picture returns
// plausible-looking numbers that are quietly wrong, which is worse than no
// answer because they look right.
//
// What it is good at is the half that steers a render. "Teal shadows, warm skin,
// crushed blacks" moves an image generator; a list of six hex codes does not.
const axios = require('axios');
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
const authHeaders = { Authorization: `Bearer ${insforgeApiKey}` };

let parsed;
try {
  parsed = JSON.parse(($flow.input || '').toString());
} catch (e) {
  return { error: 'Expected JSON {"imagePath":"output/...","swatches":["#..."]}' };
}

const swatches = Array.isArray(parsed.swatches) ? parsed.swatches.filter(Boolean) : [];
if (!swatches.length) return { error: 'No swatches were given.' };

function toViewPath(raw) {
  const norm = String(raw).split(String.fromCharCode(92)).join('/');
  const m = /(?:^|\/)(output|input|temp)\/(.+)$/i.exec(norm);
  return m ? m[1].toLowerCase() + '/' + m[2] : norm.replace(/^\//, '');
}

// Fetch the picture so the model can actually look at it.
let bytes = null;
try {
  if (parsed.imagePath) {
    const rel = toViewPath(parsed.imagePath);
    const at = rel.indexOf('/');
    const type = rel.slice(0, at);
    const rest = rel.slice(at + 1);
    const slash = rest.lastIndexOf('/');
    const res = await axios.get(`${comfyUrl}/view`, {
      params: {
        filename: slash >= 0 ? rest.slice(slash + 1) : rest,
        subfolder: slash >= 0 ? rest.slice(0, slash) : '',
        type: type
      },
      responseType: 'arraybuffer'
    });
    if (res.status === 200 && res.data && res.data.byteLength) bytes = Buffer.from(res.data);
  } else if (parsed.storageKey && parsed.movieId) {
    const mv = await axios.get(`${insforgeUrl}/api/database/records/movies`, {
      params: { id: `eq.${parsed.movieId}`, select: 'bucket_name' },
      headers: authHeaders
    });
    const bucket = (mv.data || [])[0] && mv.data[0].bucket_name;
    if (bucket) {
      // Fully encoded: an uploaded filename can contain %, [ ] and spaces.
      const res = await axios.get(
        `${insforgeUrl}/api/storage/buckets/${bucket}/objects/` + encodeURIComponent(parsed.storageKey),
        { headers: authHeaders, responseType: 'arraybuffer' }
      );
      const buf = Buffer.from(res.data);
      // A failed download comes back as a small JSON body with a 200.
      if (!(buf.length < 512 && /^\s*[{[]/.test(buf.toString('utf8').slice(0, 40)))) bytes = buf;
    }
  }
} catch (e) {
  // Not fatal - the swatches alone are enough to name something reasonable.
  bytes = null;
}

const INSTRUCTION =
  'You are a colourist naming a look.\n\n' +
  'These swatches were measured from the image, darkest to lightest:\n' +
  swatches.join(', ') + '\n\n' +
  (bytes ? 'The image itself is attached. Describe the grade you can see in it.\n\n' : '') +
  'Return ONLY JSON, no prose and no code fence:\n' +
  '{"name": "...", "description": "..."}\n\n' +
  'Rules:\n' +
  '- name: two or three words, evocative and specific, the way a film LUT is named. ' +
  '"Sodium Night", "Bleach Bypass", "Kodak Warm". Not "Palette 1", not a list of colours.\n' +
  '- description: two or three sentences a colourist would recognise. Say where the shadows sit, ' +
  'where the highlights sit, how saturated the mid-tones are, and what the light is doing. ' +
  'Describe the GRADE, not the subject of the photograph.\n' +
  '- Do not restate the hex values. Do not invent any new ones.';

let reply;
try {
  const message = { role: 'user', content: INSTRUCTION };
  if (bytes) message.images = [bytes.toString('base64')];
  const res = await llmChat(
    { model: ollamaModel, stream: false, think: false, options: { temperature: 0.7 }, messages: [message] },
    { timeout: 300000 }
  );
  reply = ((res.data && res.data.message && res.data.message.content) || '').trim();
} catch (e) {
  const detail = e.response ? JSON.stringify(e.response.data).slice(0, 300) : e.message;
  return { error: 'The vision model did not answer: ' + detail };
}

reply = reply.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
reply = reply.replace(/^```[a-z]*\s*/i, '').replace(/```\s*$/i, '').trim();

let out;
try {
  const a = reply.indexOf('{');
  const b = reply.lastIndexOf('}');
  out = JSON.parse(a >= 0 ? reply.slice(a, b + 1) : reply);
} catch (e) {
  return { error: 'The model did not return usable JSON.', raw: reply.slice(0, 400) };
}

const name = String(out.name || '').trim().slice(0, 60);
const description = String(out.description || '').trim().slice(0, 800);
if (!name) return { error: 'The model returned no name.', raw: reply.slice(0, 300) };

return {
  action: 'complete',
  name: name,
  description: description,
  sawImage: !!bytes,
  swatches: swatches
};
