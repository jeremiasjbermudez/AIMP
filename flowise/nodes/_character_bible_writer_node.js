// 23-Character-Bible-Writer: a conversation that maintains the character bible.
//
// It reads the movie's screenplay and its existing cast, then rewrites the whole
// bible on request. It does NOT write to the database - the writer reviews the
// result and commits it through the existing bible import, which is the one
// path that knows how to reconcile characters with what has already rendered.
const axios = require('axios');
const insforgeUrl = $insforgeUrl;
const insforgeApiKey = $insforgeApiKey;
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
const systemPrompt = $systemPrompt;
const authHeaders = { Authorization: 'Bearer ' + insforgeApiKey };

let parsed;
try {
  parsed = JSON.parse(($flow.input || '').toString());
} catch (e) {
  return { error: 'Expected JSON input {"movieId":"...","messages":[...]}' };
}

const movieId = parsed.movieId;
if (!movieId) return { error: 'Missing movieId.' };

const incoming = Array.isArray(parsed.messages) ? parsed.messages : [];
const messages = incoming
  .filter(function (m) { return m && (m.role === 'user' || m.role === 'assistant') && String(m.content || '').trim(); })
  .map(function (m) { return { role: m.role, content: String(m.content) }; });
if (!messages.length) return { error: 'Send at least one message.' };

const movieRes = await axios.get(insforgeUrl + '/api/database/records/movies', {
  params: { id: 'eq.' + movieId, select: 'id,title,bucket_name' },
  headers: authHeaders
});
const movie = (movieRes.data || [])[0];
if (!movie) return { error: 'Movie not found.' };

// The cast as it stands. Sent verbatim so the model keeps existing looks intact
// rather than reinventing characters that already have reference images.
const charRes = await axios.get(insforgeUrl + '/api/database/records/characters', {
  params: { movie_id: 'eq.' + movieId, select: 'name,gender,visual_anchor', order: 'name.asc' },
  headers: authHeaders
});
const existing = charRes.data || [];

// The screenplay is the source of truth for who is in the film at all.
let screenplay = '';
try {
  const docRes = await axios.get(insforgeUrl + '/api/database/records/documents', {
    params: {
      movie_id: 'eq.' + movieId,
      kind: 'eq.screenplay',
      select: 'storage_key',
      order: 'created_at.desc',
      limit: 1
    },
    headers: authHeaders
  });
  const doc = (docRes.data || [])[0];
  if (doc && doc.storage_key) {
    const strategyRes = await axios.get(
      insforgeUrl + '/api/storage/buckets/' + movie.bucket_name +
        '/download-strategy/objects/' + encodeURIComponent(doc.storage_key),
      { headers: authHeaders }
    );
    const strategy = strategyRes.data;
    const fileRes = await axios.get(strategy.url, {
      headers: strategy.method === 'direct' ? authHeaders : {},
      responseType: 'arraybuffer'
    });
    screenplay = Buffer.from(fileRes.data).toString('utf8').replace(/^﻿/, '');
  }
} catch (e) {
  // A missing or unreadable screenplay is not fatal: the writer may be building
  // the cast before the script exists. The model is told so explicitly below
  // rather than being left to wonder why the script is empty.
  screenplay = '';
}

// Screenplays run long; the model needs the shape of the story and who speaks,
// not every line. The head carries the setup and most first appearances.
const MAX_SCRIPT = 24000;
const script = screenplay.length > MAX_SCRIPT
  ? screenplay.slice(0, MAX_SCRIPT) + String.fromCharCode(10) + '[... screenplay truncated ...]'
  : screenplay;

const NL = String.fromCharCode(10);
const context = [
  'FILM: ' + movie.title,
  '',
  'EXISTING CAST (' + existing.length + '). Your reply must contain EVERY ONE of',
  'these, unchanged unless asked, PLUS anyone you add:',
  existing.length
    ? existing.map(function (c) {
        return '[' + String(c.name).toUpperCase() + ']' + NL +
               'Visual_Anchor: ' + (c.visual_anchor || '(none recorded yet - write one)');
      }).join(NL + NL)
    : '(none yet - build the cast from the screenplay)',
  '',
  '',
  'Return the complete bible: all ' + existing.length + ' existing character(s) and any new ones.',
  '',
  'SCREENPLAY:',
  script || '(no screenplay uploaded yet - work from what the writer tells you)'
].join(NL);

const MAX_TURNS = 7;
const trimmed = messages.length <= MAX_TURNS
  ? messages
  : [messages[0]].concat(messages.slice(messages.length - (MAX_TURNS - 1)));

let reply;
try {
  const res = await llmChat(
    {
      model: ollamaModel,
      stream: false,
      think: false,
      options: { temperature: 0.8, num_ctx: 32768 },
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: context }
      ].concat(trimmed)
    },
    { timeout: 900000 }
  );
  reply = ((res.data && res.data.message && res.data.message.content) || '').trim();
} catch (e) {
  const detail = e.response ? JSON.stringify(e.response.data).slice(0, 400) : e.message;
  return { error: 'The model did not answer: ' + detail };
}
if (!reply) return { error: 'The model returned nothing.' };

reply = reply.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
reply = reply.replace(/^```[a-z]*\s*/i, '').replace(/```\s*$/i, '').trim();

// Collapse runs of whitespace inside the [NAME] markers before anything reads
// them. The importer matches characters by name, so "[ZEPHYR  2]" against a
// stored "ZEPHYR 2" would not match and would create a duplicate character
// rather than updating the one that already has reference images.
reply = reply.replace(/^[ \t]*\[([^\]]+)\][ \t]*$/gm, function (whole, name) {
  return '[' + name.replace(/\s+/g, ' ').trim().toUpperCase() + ']';
});

// The bible is whatever runs from the first [NAME] marker to the end. Splitting
// it out here means the UI can offer "save as the character bible" against the
// exact text the importer will parse, not against the chat preamble too.
const firstMarker = reply.search(/^[ \t]*\[[A-Za-z0-9][^\]]*\][ \t]*$/m);
const bible = firstMarker >= 0 ? reply.slice(firstMarker).trim() : '';
const names = bible
  ? (bible.match(/^[ \t]*\[([A-Za-z0-9][^\]]*)\][ \t]*$/gm) || []).map(function (l) {
      // Only the brackets and the surrounding whitespace come off: a name can
      // legitimately contain a space ("ZEPHYR 2"), and stripping all whitespace
      // would rename the character the importer is meant to match.
      return l.replace(/^[ 	]*\[/, '').replace(/\][ 	]*$/, '').trim().toUpperCase();
    })
  : [];

return {
  reply: reply,
  bible: bible,
  characters: names,
  hadScreenplay: screenplay.length > 0
};
