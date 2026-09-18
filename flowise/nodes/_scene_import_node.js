// Builds the scenes table for the active movie from the beats already stored
// for it. Nothing in the pipeline has ever written scenes - beats and
// characters got flows, scenes did not - which is why panorama generation
// fails with "No scene row found ... Add it first."
//
// Two halves:
//
//  1. A deterministic roll-up. Beat rows already carry act_number,
//     scene_number, scene_heading, int_ext, location and time_of_day, so those
//     need no re-parse of the screenplay and no model.
//
//  2. Prose enrichment. The Panoramic Generator composes its room prompt from
//     [scene_heading, location_description, atmosphere, set_dressing]; with
//     only the heading it prompts on "EXT. TROPICAL ISLAND - DAY", far too
//     thin to render a usable panorama. Those three fields are what the scene
//     step actually exists to produce, so they are written here from the
//     scene's own beat text.
const axios = require('axios');
const insforgeUrl = $insforgeUrl;
const insforgeApiKey = $insforgeApiKey;
const authHeaders = { Authorization: `Bearer ${insforgeApiKey}` };

const rawInput = ($flow.input || '').toString().trim();
const force = /--force\b/i.test(rawInput);
// --no-prose skips the model entirely and writes only the rolled-up fields.
const skipProse = /--no-prose\b/i.test(rawInput);
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
const activeRes = await axios.get(`${insforgeUrl}/api/database/records/movies`, {
  params: { is_active: 'eq.true', select: 'id,title,slug' },
  headers: authHeaders
});
const activeMovies = activeRes.data || [];
if (activeMovies.length === 0) return { error: 'No active movie set. Select one in the pipeline-admin app first.' };
if (activeMovies.length > 1) return { error: `Found ${activeMovies.length} active movies - exactly one must be active.` };
const movie = activeMovies[0];

const beatsRes = await axios.get(`${insforgeUrl}/api/database/records/beats`, {
  params: {
    movie_id: `eq.${movie.id}`,
    select: 'act_number,scene_number,beat_number,scene_heading,int_ext,location,time_of_day,summary,characters,objects,raw_text',
    order: 'sequence_index.asc'
  },
  headers: authHeaders
});
const beats = beatsRes.data || [];
if (beats.length === 0) {
  return { error: `No beats for ${movie.title}. Run the Beat Generator first - scenes are rolled up from beats.` };
}

// Group beats by act/scene. Pre-scene content (a title sequence with no scene
// heading) has a null scene_number and is deliberately skipped: it is not a
// scene and has nothing to generate a panorama for.
const groups = {};
let skippedPreScene = 0;
for (const b of beats) {
  if (b.act_number == null || b.scene_number == null) {
    skippedPreScene += 1;
    continue;
  }
  const key = `${b.act_number}|${b.scene_number}`;
  if (!groups[key]) {
    groups[key] = {
      act_number: b.act_number,
      scene_number: b.scene_number,
      scene_heading: null,
      int_ext: null,
      location_name: null,
      time_of_day: null,
      summaries: [],
      characters: [],
      objects: [],
      rawText: []
    };
  }
  const g = groups[key];
  // First non-empty value wins: the scene's own heading comes from its first
  // beat, later beats in the same scene repeat or omit it.
  if (!g.scene_heading && b.scene_heading) {
    // Beat headings carry the shooting-script numbers at both ends
    // ("1 EXT. TROPICAL ISLAND - DAY 1"); scenes store the clean slug.
    g.scene_heading = String(b.scene_heading).replace(/^\s*\d+\s+/, '').replace(/\s+\d+\s*$/, '').trim();
  }
  if (!g.int_ext && b.int_ext) g.int_ext = b.int_ext;
  if (!g.location_name && b.location) g.location_name = b.location;
  if (!g.time_of_day && b.time_of_day) g.time_of_day = b.time_of_day;
  if (b.summary) g.summaries.push(b.summary);
  for (const c of b.characters || []) {
    if (c && c.name && g.characters.indexOf(c.name) === -1) g.characters.push(c.name);
  }
  for (const o of b.objects || []) {
    if (o && o.name && g.objects.indexOf(o.name) === -1) g.objects.push(o.name);
  }
  if (b.raw_text) g.rawText.push(b.raw_text);
}

const wanted = Object.keys(groups).map((k) => groups[k]);
if (wanted.length === 0) {
  return { error: `Beats for ${movie.title} carry no scene numbers, so no scenes could be rolled up.` };
}

const existingRes = await axios.get(`${insforgeUrl}/api/database/records/scenes`, {
  params: { movie_id: `eq.${movie.id}`, select: 'id,act_number,scene_number,location_name,location_description' },
  headers: authHeaders
});
const existing = existingRes.data || [];
const byKey = {};
for (const s of existing) byKey[`${s.act_number}|${s.scene_number}`] = s;

// Prose the Panoramic Generator actually consumes. Deliberately describes the
// EMPTY room: the panorama is a backplate that characters are composited into
// later, so people in it would be baked into the set.
const PROSE_SYSTEM = [
  'You write set descriptions for a film production pipeline. You are given one',
  'scene from a screenplay - its heading and its beat text - and you return',
  'JSON describing the physical location only.',
  '',
  'Rules:',
  '- Describe the EMPTY location. Never describe characters, actors, or people.',
  '  The output becomes a 360 panorama backplate that characters are composited',
  '  into afterwards, so anyone described here would be permanently baked in.',
  '- Only describe what the scene text supports, plus what such a place',
  '  necessarily contains. Never invent story elements or events.',
  '- Present tense, concrete and physical. No camera directions, no shot sizes,',
  '  no mood adjectives standing in for description.',
  '',
  'Return ONLY a JSON object with exactly these keys:',
  '  location_description - 2-4 sentences on the space itself: architecture,',
  '                         scale, layout, materials, light sources.',
  '  atmosphere           - 1-2 sentences on air, light quality, temperature,',
  '                         weather, general feel of the space.',
  '  set_dressing         - 1-2 sentences listing the props, furniture and',
  '                         surfaces actually in the room.',
  '  sound_ambience       - 1 sentence on the constant background sound.'
].join('\n');

async function writeProse(g) {
  const source = [
    'SCENE HEADING: ' + (g.scene_heading || ''),
    g.location_name ? 'LOCATION: ' + g.location_name : '',
    g.time_of_day ? 'TIME OF DAY: ' + g.time_of_day : '',
    g.objects.length ? 'OBJECTS PRESENT: ' + g.objects.join(', ') : '',
    g.summaries.length ? 'WHAT HAPPENS: ' + g.summaries.join(' ') : '',
    g.rawText.length ? 'SCREENPLAY TEXT:\n' + g.rawText.join('\n\n') : ''
  ].filter(Boolean).join('\n');

  const res = await llmChat(
    {
      model: ollamaModel,
      stream: false,
      think: false,
      format: 'json',
      options: { temperature: 0.4 },
      messages: [
        { role: 'system', content: PROSE_SYSTEM },
        { role: 'user', content: source }
      ]
    },
    { timeout: 300000 }
  );
  const raw = ((res.data && res.data.message && res.data.message.content) || '').trim();
  const parsed = JSON.parse(raw);
  const clean = (v) => (typeof v === 'string' && v.trim() ? v.replace(/\s+/g, ' ').trim() : null);
  return {
    location_description: clean(parsed.location_description),
    atmosphere: clean(parsed.atmosphere),
    set_dressing: clean(parsed.set_dressing),
    sound_ambience: clean(parsed.sound_ambience)
  };
}

const created = [];
const updated = [];
const skipped = [];
const proseFailed = [];

for (const g of wanted) {
  const key = `${g.act_number}|${g.scene_number}`;
  const label = `A${g.act_number}S${g.scene_number}`;
  const payload = {
    movie_id: movie.id,
    act_number: g.act_number,
    scene_number: g.scene_number,
    scene_heading: g.scene_heading,
    int_ext: g.int_ext,
    location_name: g.location_name,
    time_of_day: g.time_of_day,
    characters_present: g.characters,
    synopsis: g.summaries.join(' ') || null
  };
  if (!skipProse) {
    try {
      const prose = await writeProse(g);
      payload.location_description = prose.location_description;
      payload.atmosphere = prose.atmosphere;
      payload.set_dressing = prose.set_dressing;
      payload.sound_ambience = prose.sound_ambience;
    } catch (e) {
      // A model failure must not lose the roll-up: the scene is still written
      // with its structural fields, and the shortfall is reported.
      proseFailed.push(label + ': ' + (e && e.message ? e.message : String(e)).slice(0, 120));
    }
  }

  const current = byKey[key];

  if (!current) {
    await axios.post(`${insforgeUrl}/api/database/records/scenes`, [payload], {
      headers: { ...authHeaders, 'Content-Type': 'application/json', Prefer: 'return=minimal' }
    });
    created.push(label);
    continue;
  }

  // Existing prose (location_description and friends) is worth more than a
  // roll-up and nothing here can regenerate it, so it survives unless --force.
  // But that applies ONLY to the prose: heading, location name, characters and
  // synopsis come straight from the beats and must always follow them.
  //
  // Skipping the whole row instead - which this used to do - left a rewritten
  // screenplay showing its old scene name in every picker while the beats beside
  // it showed the new one.
  let toWrite = payload;
  let prosePreserved = false;
  // ...but prose about a DIFFERENT PLACE is not worth keeping. If the scene's
  // location name has changed, the old description is about somewhere else
  // entirely, and leaving it in place would send the panorama generator off to
  // build the wrong room - silently, since the name on screen would look right.
  const sameplace =
    String(current.location_name || '').trim().toUpperCase() ===
    String(payload.location_name || '').trim().toUpperCase();
  if (current.location_description && !force && sameplace) {
    toWrite = { ...payload };
    delete toWrite.location_description;
    delete toWrite.atmosphere;
    delete toWrite.set_dressing;
    delete toWrite.sound_ambience;
    prosePreserved = true;
  }
  await axios.patch(`${insforgeUrl}/api/database/records/scenes`, toWrite, {
    params: { id: `eq.${current.id}` },
    headers: { ...authHeaders, 'Content-Type': 'application/json', Prefer: 'return=minimal' }
  });
  if (prosePreserved) skipped.push(label + ' (prose kept, heading updated)');
  updated.push(label);
}

return {
  action: 'scenes-rolled-up',
  movie: movie.title,
  beatsRead: beats.length,
  scenesFound: wanted.length,
  created,
  updated,
  skipped,
  skippedPreSceneBeats: skippedPreScene,
  proseWritten: skipProse ? 0 : wanted.length - proseFailed.length,
  proseFailed,
  model: skipProse ? null : ollamaModel
};
