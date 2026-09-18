// Looks at an image from the project and writes text from it.
//
// Two jobs, because both are the same job with a different instruction: describe
// a LOCATION as a panorama prompt (the default), or describe a PROP from its
// reference sheet (mode "prop").
//
// This is the VISION model on the dedicated Ollama box - qwen3.8 reports
// ['completion','vision','tools','thinking'] - not the qwen text encoder inside
// the Klein graph. Those are different things that happen to share a name: the
// encoder turns text into conditioning, this one actually looks at a picture.
//
// It returns a prompt only. Nothing is generated and nothing is saved, so the
// operator reads and edits it before it drives anything.
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

// The opening the pipeline needs. A panorama whose walls crowd the camera is
// useless as a plate - the splat built from it has nowhere to stand - so the
// framing is fixed and only the description varies.
const OPENING = '360 equirectangular panorama, a vast and highly spacious ';

// A prop's sheet, once it exists, is the authority: it is the picture the
// renderer is handed as a tagged reference, so the words in movie_props should
// describe THAT, not the guess that produced it. A sheet uploaded from outside -
// a photograph of the real object - has no words behind it at all.
//
// Scale is asked for separately and explicitly, exactly as it is when a prop is
// proposed from the script: a model describing an object will write what it
// looks like and say nothing about how big it is, and size is the field that
// stops it changing between shots.
const PROP_INSTRUCTION = [
  'You are looking at a reference sheet for a single film prop or costume. It may show the same',
  'object from several angles.',
  '',
  'Describe the OBJECT, not the sheet.',
  '',
  'Rules:',
  '- description: what it looks like - shape, colour, material, condition, and the details that',
  '  would let someone draw it again. Appearance only. Under 40 words. Describe ONE state, the',
  '  way it appears here.',
  '- scale_note: how big the REAL thing is in the world of the film, against something known',
  '  ("fits in a cupped hand", "as long as a standard car", "as tall as a person").',
  '  IGNORE any measurement printed on the sheet. A reference sheet is often photographed from a',
  '  model or a toy, and its printed size is the model\'s, not the object\'s - a sheet of a car',
  '  marked "8in" is an eight-inch model of a four-metre car. Judge from what the thing IS.',
  '  Never leave it empty.',
  '- Do not mention the background, the layout of the views, arrows, labels or measurements as',
  '  objects. Do not describe any people.',
  '',
  'Return ONLY JSON: {"description":"...","scale_note":"..."}'
].join('\n');

const INSTRUCTION =
  'You are looking at a reference image for a film location. Describe THAT PLACE as a single ' +
  'flowing prompt for a 360 degree panorama.\n\n' +
  'Rules:\n' +
  '- Begin your answer with exactly: "' + OPENING + '"\n' +
  '- Continue in the same sentence with the architecture, materials, colours, light and mood you ' +
  'can actually see. Be concrete: name surfaces, structures and light sources.\n' +
  '- Describe the location as seen from the CENTRE of the space, with the walls and features far ' +
  'away on every side.\n' +
  '- Do not describe any people, and do not invent a story or camera moves.\n' +
  '- No lists, no headings, no preamble, no quotation marks. One paragraph, under 90 words.';

let parsed;
try {
  parsed = JSON.parse(($flow.input || '').toString());
} catch (e) {
  return { error: 'Expected JSON input {"imagePath":"output/..."} or {"storageKey":"..."}' };
}

function toViewPath(raw) {
  const norm = String(raw).split(String.fromCharCode(92)).join('/');
  const m = /(?:^|\/)(output|input|temp)\/(.+)$/i.exec(norm);
  return m ? m[1].toLowerCase() + '/' + m[2] : norm.replace(/^\//, '');
}

// Fetch the picture as bytes, whichever store it lives in.
let bytes;
try {
  if (parsed.imagePath) {
    const rel = toViewPath(parsed.imagePath);
    const at = rel.indexOf('/');
    const type = rel.slice(0, at);
    const rest = rel.slice(at + 1);
    const lastSlash = rest.lastIndexOf('/');
    const filename = lastSlash >= 0 ? rest.slice(lastSlash + 1) : rest;
    const subfolder = lastSlash >= 0 ? rest.slice(0, lastSlash) : '';
    const res = await axios.get(`${comfyUrl}/view`, {
      params: { filename, subfolder, type },
      responseType: 'arraybuffer'
    });
    fetchInfo = 'raw=' + JSON.stringify(parsed.imagePath) + ' filename=' + filename +
      ' subfolder=' + subfolder + ' type=' + type + ' | type=' + typeof res.data + ' ctor=' + (res.data && res.data.constructor && res.data.constructor.name) +
      ' len=' + (res.data && (res.data.byteLength || res.data.length)) + ' status=' + res.status;
    if (res.status !== 200 || !res.data || !res.data.byteLength) {
      // Callers must send forward slashes. A stored Windows path like
      // "output/_ImageEdits\anime-test/x.png" loses its backslash on the way
      // here - JSON reads \a as a BEL character - so the subfolder arrives
      // mangled and ComfyUI 404s. Saying that plainly beats an empty answer.
      return {
        error: 'ComfyUI could not find that image (HTTP ' + res.status + '). Looked for "' +
          filename + '" in "' + subfolder + '". If the path contains backslashes, send it with ' +
          'forward slashes instead.'
      };
    }
    bytes = Buffer.from(res.data);
  } else if (parsed.storageKey && parsed.movieId) {
    const movieRes = await axios.get(`${insforgeUrl}/api/database/records/movies`, {
      params: { id: `eq.${parsed.movieId}`, select: 'bucket_name' },
      headers: authHeaders
    });
    const bucket = (movieRes.data || [])[0] && movieRes.data[0].bucket_name;
    if (!bucket) return { error: 'Movie not found.' };
    const strategyRes = await axios.get(
      `${insforgeUrl}/api/storage/buckets/${bucket}/download-strategy/objects/${encodeURIComponent(parsed.storageKey)}`,
      { headers: authHeaders }
    );
    const strategy = strategyRes.data;
    const fileRes = await axios.get(strategy.url, {
      headers: strategy.method === 'direct' ? authHeaders : {},
      responseType: 'arraybuffer'
    });
    bytes = Buffer.from(fileRes.data);
  } else {
    return { error: 'Give an imagePath, or a storageKey with a movieId.' };
  }
} catch (e) {
  const detail = e.response ? `HTTP ${e.response.status}` : e.message;
  return { error: 'Could not read that image: ' + detail };
}

const isProp = String(parsed.mode || '').toLowerCase() === 'prop';
const notes = (parsed.notes || '').toString().trim();
const userParts = [isProp ? PROP_INSTRUCTION : INSTRUCTION];
if (notes) userParts.push('The operator adds: ' + notes + '. Honour this over what the image shows where they conflict.');
// The prop's own name, so the model describes the right thing on a sheet that
// happens to show more than one - a costume on a stand, a prop in a hand.
if (isProp && parsed.name) userParts.push('The object is called: ' + String(parsed.name) + '.');

let reply;
try {
  const res = await llmChat(
    {
      model: ollamaModel,
      stream: false,
      // Reasoning would be prepended to the prompt and end up in the panorama.
      think: false,
      // A description of a picture is a reading, not a piece of writing - the
      // panorama prompt wants some invention, this wants none.
      options: { temperature: isProp ? 0.1 : 0.6 },
      ...(isProp ? { format: 'json' } : {}),
      messages: [
        {
          role: 'user',
          content: userParts.join('\n\n'),
          // Ollama takes images as bare base64 on the message.
          images: [bytes.toString('base64')]
        }
      ]
    },
    { timeout: 300000 }
  );
  reply = ((res.data && res.data.message && res.data.message.content) || '').trim();
} catch (e) {
  const detail = e.response ? JSON.stringify(e.response.data).slice(0, 300) : e.message;
  return { error: 'The vision model did not answer: ' + detail };
}
if (!reply) {
  // Report what was actually sent, so an empty answer can be told apart from a
  // broken image - the two look identical from the outside.
  return { error: 'The vision model returned nothing.', sourceBytes: bytes ? bytes.length : 0 };
}

reply = reply.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
reply = reply.replace(/^```[a-z]*\s*/i, '').replace(/```\s*$/i, '').trim();
reply = reply.replace(/^["']|["']$/g, '').trim();

// A prop answer is JSON and takes none of the panorama's shaping below - the
// enforced 360 opening would be nonsense on a description of a crystal.
if (isProp) {
  let out;
  try {
    out = JSON.parse(reply);
  } catch (e) {
    return { error: 'The vision model did not return JSON.', reply: reply.slice(0, 300) };
  }
  const description = String(out.description || '').trim();
  const scale_note = String(out.scale_note || '').trim();
  if (!description) return { error: 'The vision model described nothing.', reply: reply.slice(0, 300) };
  // Returned, never written. The operator reads it against the picture before it
  // replaces words that are already driving renders.
  return { action: 'described', description, scale_note, sourceBytes: bytes.length };
}

// The opening is a pipeline requirement, so it is enforced rather than hoped
// for - a model that paraphrases it would otherwise quietly drop the framing.
if (!reply.toLowerCase().startsWith(OPENING.trim().toLowerCase())) {
  reply = reply.replace(/^360[^,]*,\s*/i, '');
  reply = OPENING + reply.charAt(0).toLowerCase() + reply.slice(1);
}

return {
  action: 'complete',
  prompt: reply,
  words: reply.split(/\s+/).length,
  sourceBytes: bytes.length
};
