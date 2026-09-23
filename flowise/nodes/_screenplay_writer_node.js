// 22-Screenplay-Writer: a conversation that produces a whole screenplay.
//
// The writer describes an idea and gets a complete script back, then refines it
// by talking ("darker", "lose the brother"). Each turn returns the FULL
// screenplay again rather than a patch, because the next thing that happens to
// it is being pasted into the breakdown, which needs the whole document.
//
// No tools and no database access: this flow invents, it does not read or write
// the movie. Committing what it produces is the breakdown's job.
const axios = require('axios');
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
// llmSettings() reads the app's model choice from the database with these.
// Without them it threw, and every call quietly used the installed model.
const insforgeUrl = $insforgeUrl;
const insforgeApiKey = $insforgeApiKey;

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
const systemPrompt = $systemPrompt;

let parsed;
try {
  parsed = JSON.parse(($flow.input || '').toString());
} catch (e) {
  return { error: 'Expected JSON input {"messages":[{"role":"user","content":"..."}]}' };
}

const incoming = Array.isArray(parsed.messages) ? parsed.messages : [];
const messages = incoming
  .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && String(m.content || '').trim())
  .map((m) => ({ role: m.role, content: String(m.content) }));

if (!messages.length) return { error: 'Nothing to write from - send at least one message.' };

// A screenplay is long, and every refinement resends the previous draft, so the
// history grows fast. Keeping the first turn (the premise) plus a recent window
// holds the brief in view without paying to replay every superseded draft.
const MAX_TURNS = 9;
const trimmed =
  messages.length <= MAX_TURNS
    ? messages
    : [messages[0]].concat(messages.slice(messages.length - (MAX_TURNS - 1)));

let reply;
try {
  const res = await llmChat(
    {
      model: ollamaModel,
      stream: false,
      // The writer asked not to watch it think, and the reply is pasted
      // straight into the breakdown - reasoning text would corrupt the script.
      think: false,
      // Warm enough to invent, cool enough to hold the output format.
      options: { temperature: 0.85, num_ctx: 32768 },
      messages: [{ role: 'system', content: systemPrompt }].concat(trimmed)
    },
    // A full screenplay is thousands of tokens on a local box; the default
    // two minutes is not enough and the failure looks like a hang.
    { timeout: 900000 }
  );
  reply = ((res.data && res.data.message && res.data.message.content) || '').trim();
} catch (e) {
  const detail = e.response ? JSON.stringify(e.response.data).slice(0, 400) : e.message;
  return { error: 'The model did not answer: ' + detail };
}

if (!reply) return { error: 'The model returned nothing.' };

// Strip the habits the instruction forbids but models fall back into anyway.
reply = reply.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
reply = reply.replace(/^```[a-z]*\s*\n?/i, '').replace(/\n?```\s*$/i, '').trim();
reply = reply.replace(/^(here(?:'s| is)[^\n]*screenplay[^\n]*:?)\s*\n+/i, '').trim();

// Scene numbering is mechanical, so it is enforced here rather than hoped for.
// Observed failure: the model fills the trailing slot with a DAY number (a real
// screenplay convention) instead of repeating the scene number, and it can
// restart numbering at each act. Both corrupt the breakdown, and both are
// fixable exactly - renumber in document order and make the two ends agree.
//
// Written as one multiline replace rather than split/join so this source
// carries no newline literals for the tooling that generates it to mangle.
let sceneNo = 0;
reply = reply.replace(
  /^[ \t]*(\d+)[ \t]+(INT|EXT)\.[ \t]*(.+?)[ \t]*$/gim,
  function (whole, lead, ie, body) {
    sceneNo += 1;
    return sceneNo + ' ' + ie.toUpperCase() + '. ' + body.replace(/\s+\d+$/, '').trim() + ' ' + sceneNo;
  }
);

// A short piece often comes back with no act markers at all. The breakdown uses
// "END OF ACT n" to close the last act, so a script without one leaves its final
// scenes outside any act. One is appended when the model wrote none - it is
// never inserted between scenes, since where an act break falls is a story
// decision and guessing it would be worse than leaving one act.
if (!/^END OF ACT\s+\d+/im.test(reply)) {
  reply = reply.replace(/\s*$/, '') + String.fromCharCode(10, 10) + 'END OF ACT 1';
}

// Whether this looks like a script decides if the UI offers "Use for breakdown",
// so the answer is computed here rather than re-derived from the text in React.
const headings = (reply.match(/^\s*\d+\s+(INT|EXT)\.[^\n]*$/gim) || []).length;
const acts = (reply.match(/^END OF ACT\s+\d+/gim) || []).length;

return {
  reply: reply,
  isScreenplay: headings > 0,
  scenes: headings,
  acts: acts
};
