// The score agent: reads a beat and proposes several contrasting cues for it.
//
// This is not a randomiser. A random draw over a thousand style tags produces
// "polka + funeral + trap" as readily as anything usable, because the axes are
// not independent - function, mood and arc are decided by the story, and only
// instrumentation and era are genuinely free.
//
// So the agent is given the taxonomy and the beat, and asked to CHOOSE the
// story-bound axes itself, then vary the free ones between takes. The last take
// is deliberately a reading against the scene - the thing a composer offers and
// a dice roll never will.
//
// It returns proposals only. Nothing is written and nothing is rendered; the
// operator picks one and sends it to the Score tab as normal.
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
const authHeaders = { Authorization: `Bearer ${insforgeApiKey}` };

let parsed;
try {
  parsed = JSON.parse(($flow.input || '').toString());
} catch (e) {
  return { error: 'Expected JSON input {"beatId":"..."} or {"movieId":"...","brief":"..."}' };
}

const takes = Math.min(6, Math.max(1, Number(parsed.takes) || 4));

// ------------------------------------------------------------ the taxonomy
const stylesRes = await axios.get(`${insforgeUrl}/api/database/records/score_styles`, {
  params: { select: 'axis,label,descriptor,bpm_min,bpm_max,quality', order: 'axis.asc,sort_order.asc' },
  headers: authHeaders
});
const styles = stylesRes.data || [];
if (!styles.length) return { error: 'No styles are defined yet.' };

const byAxis = {};
for (const s of styles) (byAxis[s.axis] = byAxis[s.axis] || []).push(s);

function axisList(axis) {
  return (byAxis[axis] || [])
    .map((s) => '  - ' + s.label + (s.descriptor ? ': ' + s.descriptor : ''))
    .join('\n');
}

// ---------------------------------------------------------------- the beat
let context = String(parsed.brief || '').trim();
let beat = null;
let scene = null;
if (parsed.beatId) {
  const beatRes = await axios.get(`${insforgeUrl}/api/database/records/beats`, {
    params: {
      id: `eq.${parsed.beatId}`,
      select: 'id,movie_id,beat_code,act_number,scene_number,summary,characters,dialogue,raw_text'
    },
    headers: authHeaders
  });
  beat = (beatRes.data || [])[0];
  if (!beat) return { error: 'That beat no longer exists.' };

  const sceneRes = await axios.get(`${insforgeUrl}/api/database/records/scenes`, {
    params: {
      movie_id: `eq.${beat.movie_id}`,
      act_number: `eq.${beat.act_number}`,
      scene_number: `eq.${beat.scene_number}`,
      select: 'location_name,time_of_day,atmosphere,synopsis,int_ext'
    },
    headers: authHeaders
  });
  scene = (sceneRes.data || [])[0] || null;

  const lines = [];
  lines.push('Beat ' + (beat.beat_code || '') + ': ' + (beat.summary || ''));
  if (scene) {
    lines.push('Location: ' + [scene.int_ext, scene.location_name, scene.time_of_day].filter(Boolean).join('. '));
    if (scene.atmosphere) lines.push('Atmosphere: ' + scene.atmosphere);
  }
  const cast = Array.isArray(beat.characters)
    ? beat.characters.map((c) => (c && c.name) || c).filter(Boolean).join(', ')
    : '';
  if (cast) lines.push('Present: ' + cast);
  if (beat.raw_text) lines.push('Script:\n' + String(beat.raw_text).slice(0, 1500));
  context = lines.join('\n');
}
if (!context) return { error: 'Give a beatId, or a brief describing the scene.' };

// ------------------------------------------------------------------ prompt
const INSTRUCTION =
  'You are a film composer proposing cues for one beat of a screenplay.\n\n' +
  'Choose from these axes. FUNCTION, MOOD and ARC are decided by the story - pick what the scene ' +
  'actually needs. INSTRUMENTATION and ERA are free: vary them between takes so the options are ' +
  'genuinely different from each other rather than the same cue reworded.\n\n' +
  'FUNCTION:\n' + axisList('function') + '\n\n' +
  'MOOD:\n' + axisList('mood') + '\n\n' +
  'ARC:\n' + axisList('arc') + '\n\n' +
  'INSTRUMENTATION:\n' + axisList('instrumentation') + '\n\n' +
  'ERA:\n' + axisList('era') + '\n\n' +
  'Propose exactly ' + takes + ' cues. Make the LAST one a deliberate reading AGAINST the scene - ' +
  'the unexpected choice a composer would offer, and say so in its note.\n\n' +
  'Return ONLY a JSON array, no prose and no code fence. Each element:\n' +
  '{"title": "short name", "function": "...", "mood": "...", "arc": "...", ' +
  '"instrumentation": "...", "era": "...", "bpm": 96, "keyscale": "D minor", ' +
  '"timesignature": "4", "caption": "...", "note": "one line on why this reading"}\n\n' +
  'Rules:\n' +
  '- function, mood, arc, instrumentation and era MUST be labels copied exactly from the lists.\n' +
  '- keyscale is "<root> <major|minor>", e.g. "F# minor". Honour the mood: a mood listed as minor ' +
  'must not be given a major key.\n' +
  '- bpm must sit inside the range the chosen mood allows.\n' +
  '- timesignature is one of 2, 3, 4, 6.\n' +
  '- caption is the prompt handed to the music model. One flowing paragraph naming genre, ' +
  'instruments, tempo, key and how the piece opens, develops and ends. Commit to concrete values. ' +
  'Never use square brackets or placeholders.\n' +
  '- These are instrumental score cues. No lyrics, no vocals unless the function is "source".';

let reply;
try {
  const res = await llmChat(
    {
      model: ollamaModel,
      stream: false,
      think: false,
      options: { temperature: 0.9 },
      messages: [
        { role: 'system', content: 'You output JSON only.' },
        { role: 'user', content: INSTRUCTION + '\n\nTHE BEAT:\n' + context }
      ]
    },
    { timeout: 300000 }
  );
  reply = ((res.data && res.data.message && res.data.message.content) || '').trim();
} catch (e) {
  const detail = e.response ? JSON.stringify(e.response.data).slice(0, 300) : e.message;
  return { error: 'The model did not answer: ' + detail };
}

reply = reply.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
reply = reply.replace(/^```[a-z]*\s*/i, '').replace(/```\s*$/i, '').trim();

let proposals;
try {
  const start = reply.indexOf('[');
  const end = reply.lastIndexOf(']');
  proposals = JSON.parse(start >= 0 ? reply.slice(start, end + 1) : reply);
} catch (e) {
  return { error: 'The model did not return usable JSON.', raw: reply.slice(0, 600) };
}
if (!Array.isArray(proposals) || !proposals.length) {
  return { error: 'The model returned no cues.', raw: reply.slice(0, 400) };
}

// --------------------------------------------------------------- validate
// The model picks; this makes sure what it picked is actually renderable. A
// caption is worth nothing if its key or BPM would be rejected downstream.
const ROOTS = ['C', 'C#', 'Db', 'D', 'D#', 'Eb', 'E', 'F', 'F#', 'Gb', 'G', 'G#', 'Ab', 'A', 'A#', 'Bb', 'B'];
const moodByLabel = {};
for (const m of byAxis['mood'] || []) moodByLabel[m.label] = m;

const clean = [];
for (const p of proposals) {
  const caption = String((p && p.caption) || '').trim();
  if (!caption) continue;
  if (/\[[^\]]{3,}\]/.test(caption)) continue; // a bracketed skeleton, not a caption

  const mood = moodByLabel[p.mood] || null;
  let bpm = Math.round(Number(p.bpm) || 0);
  if (!bpm) bpm = 100;
  if (mood && mood.bpm_min && mood.bpm_max) {
    bpm = Math.min(mood.bpm_max, Math.max(mood.bpm_min, bpm));
  }
  bpm = Math.min(300, Math.max(10, bpm));

  let keyscale = String(p.keyscale || '').trim();
  const km = /^([A-G](?:#|b)?)\s+(major|minor)$/i.exec(keyscale);
  let root = km ? km[1].charAt(0).toUpperCase() + km[1].slice(1) : 'D';
  let quality = km ? km[2].toLowerCase() : 'minor';
  if (ROOTS.indexOf(root) < 0) root = 'D';
  // A mood the taxonomy calls minor does not get a major key, whatever the
  // model said - that mismatch is audible immediately.
  if (mood && mood.quality) quality = mood.quality;
  keyscale = root + ' ' + quality;

  const ts = ['2', '3', '4', '6'].indexOf(String(p.timesignature)) >= 0 ? String(p.timesignature) : '4';

  // Keep the prose honest. The clamp above can move the BPM into the mood's
  // range, and the caption often names a tempo too - "at 130 bpm" while the
  // structured value says 140 reads as a mistake, and ACE is handed the
  // structured one.
  let alignedCaption = caption.replace(
    /(\bat\s+)(\d{2,3})(\s*bpm)/gi,
    (m, a, n, b) => (Number(n) === bpm ? m : a + bpm + b)
  );
  alignedCaption = alignedCaption.replace(
    /(\b)(\d{2,3})(\s*BPM\b)/g,
    (m, a, n, b) => (Number(n) === bpm ? m : a + bpm + b)
  );

  clean.push({
    title: String(p.title || '').trim() || 'Untitled cue',
    function: String(p.function || '').trim(),
    mood: String(p.mood || '').trim(),
    arc: String(p.arc || '').trim(),
    instrumentation: String(p.instrumentation || '').trim(),
    era: String(p.era || '').trim(),
    bpm: bpm,
    keyscale: keyscale,
    timesignature: ts,
    caption: alignedCaption,
    note: String(p.note || '').trim()
  });
}

if (!clean.length) return { error: 'Every cue the model returned was unusable.', raw: reply.slice(0, 400) };

return {
  action: 'complete',
  beatCode: beat ? beat.beat_code : null,
  beatId: beat ? beat.id : null,
  count: clean.length,
  proposals: clean
};
