const rawInput = ($flow.input || '').toString();
let parsed;
try { parsed = JSON.parse(rawInput); } catch (e) {
  return { error: 'Expected JSON input {"draft":"...","motion":"...","imageBase64":"..."}, got: ' + rawInput.slice(0, 200) };
}

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
// The system prompt can now come FROM THE CALLER, so each video tab can be told
// what to do with its clips without editing this flow.
//
// $systemPrompt - the one configured on the node - stays the default, so every
// existing caller behaves exactly as before. An override only applies when one
// is actually sent and is not blank: an empty box means "no opinion", not
// "run with no system prompt at all", which would strip the output contract and
// return prose instead of a prompt.
const systemPrompt = (parsed.systemPrompt || '').toString().trim() || $systemPrompt;
const systemFrom = (parsed.systemPrompt || '').toString().trim() ? 'caller' : 'flow';

const draft = (parsed.draft || '').toString().trim();
const motion = (parsed.motion || '').toString().trim();
const imageBase64 = (parsed.imageBase64 || '').toString().trim();

if (!draft && !motion && !imageBase64) {
  return { error: 'Nothing to enhance: supply a motion request, a draft prompt, or an image.' };
}

// Dialogue is script, not description, so it has to survive the rewrite intact.
// The instruction says as much, but instructions are not a guarantee - an
// earlier version silently dropped two of four lines - so the count is checked
// here and a shortfall is never returned as if it were a success.
const countDialogue = (t) => (String(t).match(/<d>/gi) || []).length;
const expectedLines = Math.max(countDialogue(draft), countDialogue(motion));

const userParts = [];
if (motion) userParts.push('MOTION REQUEST: ' + motion);
if (draft) userParts.push('DRAFT PROMPT (mine for motion and speech only; discard its structure and scene description):\n' + draft);
if (!motion && !draft) userParts.push('MOTION REQUEST: infer a single natural motion for this image.');
if (expectedLines > 0) {
  userParts.push('This source contains ' + expectedLines + ' dialogue line(s). Your output must contain exactly ' + expectedLines + ' <d> tag(s), word for word, in the same order.');
}

const baseMessage = { role: 'user', content: userParts.join('\n\n') };
// qwen3.8 is multimodal; Ollama takes images as bare base64 on the message.
if (imageBase64) baseMessage.images = [imageBase64.replace(/^data:[^;]+;base64,/, '')];

async function ask(messages) {
  const res = await llmChat(
    {
      model: ollamaModel,
      stream: false,
      // The model has a thinking capability; the output contract wants the
      // prompt only, so reasoning is disabled rather than filtered after.
      think: false,
      options: { temperature: 0.7 },
      messages: messages
    },
    { timeout: 300000 }
  );
  return ((res.data && res.data.message && res.data.message.content) || '').trim();
}

function clean(raw) {
  let text = String(raw).trim();
  // Belt and braces against the preamble habits the instruction forbids.
  text = text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  text = text.replace(/^(here(?:'s| is) (?:your |the )?prompt:?|prompt:)\s*/i, '').trim();
  text = text.replace(/^```[a-z]*\s*/i, '').replace(/```$/, '').trim();
  // The model has been observed echoing the output contract back.
  const placeholder = text.search(/<the prompt string|no labels, no headers, no commentary>/i);
  if (placeholder > 0) text = text.slice(0, placeholder).trim();
  const blocks = text.split(new RegExp('\\n\\s*\\n')).map((b) => b.trim()).filter(Boolean);
  // Collapse a repeated answer to its first block ONLY when doing so loses no
  // dialogue. A genuine multi-line dialogue prompt spans blocks, and blindly
  // taking blocks[0] would drop lines - the exact bug this guard exists for.
  if (blocks.length > 1 && countDialogue(blocks[0]) >= countDialogue(text)) text = blocks[0];
  return text.trim();
}

const messages = [{ role: 'system', content: systemPrompt }, baseMessage];

let text;
try {
  text = clean(await ask(messages));
} catch (e) {
  const detail = e.response && e.response.data ? JSON.stringify(e.response.data).slice(0, 400) : (e.message || String(e));
  return { error: 'Ollama request failed: ' + detail };
}

let retried = false;
if (expectedLines > 0 && countDialogue(text) < expectedLines) {
  retried = true;
  try {
    const followUp = messages.concat([
      { role: 'assistant', content: text },
      {
        role: 'user',
        content:
          'You dropped dialogue. Your output had ' + countDialogue(text) + ' <d> tag(s) but the source has ' +
          expectedLines + '. Rewrite with every line restored, verbatim and in order. Dialogue does not count ' +
          'toward the word budget. Output the prompt only.'
      }
    ]);
    const second = clean(await ask(followUp));
    // Keep whichever attempt preserved more of the script.
    if (countDialogue(second) >= countDialogue(text)) text = second;
  } catch (e) {
    // Keep the first attempt; the check below still reports the shortfall.
  }
}

if (!text) return { error: 'Model returned an empty prompt.' };

const gotLines = countDialogue(text);
if (expectedLines > 0 && gotLines < expectedLines) {
  return {
    error:
      'Enhancer dropped dialogue: kept ' + gotLines + ' of ' + expectedLines + ' lines even after a retry. ' +
      'Your prompt has been left unchanged - use "Fill from beat" for this shot.',
    droppedDialogue: true,
    expectedLines: expectedLines,
    gotLines: gotLines
  };
}

// The 20-60 word budget covers motion text only, so report it that way rather
// than a total that a dialogue-heavy beat would blow past legitimately.
const motionWords = text.replace(/<d>[\s\S]*?<\/d>/gi, '').split(/\s+/).filter(Boolean).length;
// systemFrom is reported so the tab can say which instructions actually ran.
// Without it a pasted system prompt that never arrived looks identical to one
// that did, and the only evidence is the output being subtly unchanged.
return { prompt: text, motionWords, dialogueLines: gotLines, retried, model: ollamaModel, systemFrom };
