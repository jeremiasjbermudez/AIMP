// Screenplay Builder assistant. Three jobs, one flow:
//
//   breakdown - take prose the user wrote and structure it into acts, scenes
//               and beats
//   enhance   - take one beat and fill it in / sharpen it
//   bible     - read a movie's beats and propose a character bible plus
//               location descriptions
//
// It NEVER writes to the database. Every mode returns a proposal that the UI
// shows for review, and the user commits through the normal write paths. That
// keeps a bad generation from silently overwriting authored work.
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
const insforgeUrl = $insforgeUrl;
const insforgeApiKey = $insforgeApiKey;
const authHeaders = { Authorization: `Bearer ${insforgeApiKey}` };

let parsed;
try {
  parsed = JSON.parse(($flow.input || '').toString());
} catch (e) {
  return { error: 'Expected a JSON body with a "mode" field.' };
}
const mode = parsed.mode;

async function ask(system, user) {
  const res = await llmChat(
    {
      model: ollamaModel,
      stream: false,
      think: false,
      format: 'json',
      options: { temperature: 0.6, num_ctx: 32768 },
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user }
      ]
    },
    { timeout: 600000 }
  );
  const raw = ((res.data && res.data.message && res.data.message.content) || '').trim();
  return JSON.parse(raw);
}

// The beat shape is deliberately identical to what 1-Beat-Generator produces,
// so authored and generated beats are interchangeable everywhere downstream.
const BEAT_SHAPE = [
  'A beat is one continuous unit of action inside a single scene. Each beat is:',
  '  action_text - the action prose: what we SEE happen. Present tense. No camera directions.',
  '  summary     - one sentence describing the beat.',
  '  characters  - [{ "name": "UPPERCASE NAME", "presence": "in_scene"|"voice_only"|"off_screen", "blocking": "what they are doing" }]',
  '  objects     - [{ "name": "thing", "notes": "how it is used" }]',
  '  dialogue    - [{ "character": "UPPERCASE NAME", "parenthetical": "how they say it or null", "line": "the words spoken" }]',
  '',
  'Character names are UPPERCASE and identical every time the same person appears.',
  'Never invent dialogue for a beat that has none. Never write camera directions.'
].join('\n');

// ------------------------------------------------------------- breakdown
if (mode === 'breakdown') {
  const text = (parsed.text || '').toString().trim();
  if (!text) return { error: 'Nothing to break down - write something first.' };

  const system = [
    'You turn prose into screenplay structure for a film production pipeline.',
    'You are given what a writer has written - it may be a rough idea, an outline,',
    'a short story or a chapter. You return it structured as acts, scenes and beats.',
    '',
    'Rules:',
    '- A SCENE is one continuous location and time. A new location or a time jump',
    '  starts a new scene.',
    '- Every scene has int_ext ("INT", "EXT" or "INT/EXT"), a location name and a',
    '  time_of_day. These are REQUIRED - a scene without them cannot be rendered.',
    '- Split into beats only where there is a real shift within the scene (someone',
    '  arrives or leaves, the subject changes). Most scenes are one or two beats.',
    '- Expand what is thin: if the writer gave you a sentence, write the action out',
    '  properly. Do not invent plot they did not imply.',
    '- Use as many acts as the material supports; one act is fine for short pieces.',
    '',
    BEAT_SHAPE,
    '',
    'Return ONLY JSON:',
    '{ "acts": [ { "scenes": [ { "int_ext": "INT", "location": "THE CRYPT",',
    '  "time_of_day": "NIGHT", "beats": [ { ...beat... } ] } ] } ] }'
  ].join('\n');

  try {
    const out = await ask(system, text);
    const acts = out && Array.isArray(out.acts) ? out.acts : [];
    if (acts.length === 0) return { error: 'The model returned no acts. Try again, or write a little more first.' };
    return {
      proposal: { acts },
      scenes: acts.reduce((n, a) => n + ((a.scenes || []).length), 0),
      beats: acts.reduce((n, a) => n + (a.scenes || []).reduce((m, s) => m + ((s.beats || []).length), 0), 0)
    };
  } catch (e) {
    return { error: 'Breakdown failed: ' + (e && e.message ? e.message : String(e)) };
  }
}

// --------------------------------------------------------------- enhance
if (mode === 'enhance') {
  const beat = parsed.beat || {};
  const instruction = (parsed.instruction || '').toString().trim();

  const system = [
    'You improve one beat of a screenplay. You are given the beat as it stands and',
    'the scene it sits in. You return the SAME beat, filled in and sharpened.',
    '',
    'Rules:',
    '- Keep what the writer already wrote. Sharpen and extend it; do not replace',
    '  their intent with your own.',
    '- Never drop an existing dialogue line. You may add lines if the beat calls',
    '  for them.',
    '- If action_text is empty, write it from the summary and the dialogue.',
    '- Keep character names exactly as given.',
    '',
    BEAT_SHAPE,
    '',
    'Return ONLY JSON with the keys: action_text, summary, characters, objects, dialogue.'
  ].join('\n');

  const user = [
    'SCENE: ' + (parsed.sceneHeading || '(no heading)'),
    instruction ? 'WHAT TO CHANGE: ' + instruction : '',
    'BEAT AS IT STANDS:',
    JSON.stringify(beat, null, 2)
  ].filter(Boolean).join('\n\n');

  try {
    const out = await ask(system, user);
    const before = (beat.dialogue || []).length;
    const after = (out.dialogue || []).length;
    return {
      beat: {
        action_text: out.action_text || beat.action_text || '',
        summary: out.summary || beat.summary || '',
        characters: Array.isArray(out.characters) ? out.characters : (beat.characters || []),
        objects: Array.isArray(out.objects) ? out.objects : (beat.objects || []),
        // Never let an enhancement silently delete script.
        dialogue: after >= before ? (out.dialogue || []) : (beat.dialogue || [])
      },
      dialogueKept: after >= before
    };
  } catch (e) {
    return { error: 'Enhance failed: ' + (e && e.message ? e.message : String(e)) };
  }
}

// ------------------------------------------------------------------ bible
if (mode === 'bible') {
  const movieId = parsed.movieId;
  if (!movieId) return { error: 'Missing movieId.' };

  const beatsRes = await axios.get(`${insforgeUrl}/api/database/records/beats`, {
    params: {
      movie_id: `eq.${movieId}`,
      select: 'act_number,scene_number,scene_heading,int_ext,location,time_of_day,summary,action_text,characters,objects,dialogue',
      order: 'sequence_index.asc'
    },
    headers: authHeaders
  });
  const beats = beatsRes.data || [];
  if (beats.length === 0) return { error: 'No beats saved yet - write and save the screenplay first.' };

  const names = [];
  for (const b of beats) for (const c of b.characters || []) {
    if (c && c.name && names.indexOf(c.name) === -1) names.push(c.name);
  }
  const locations = [];
  for (const b of beats) {
    const key = (b.act_number || 1) + '|' + b.scene_number;
    if (!locations.some((l) => l.key === key)) {
      locations.push({
        key,
        act_number: b.act_number,
        scene_number: b.scene_number,
        scene_heading: b.scene_heading,
        location: b.location,
        int_ext: b.int_ext,
        time_of_day: b.time_of_day,
        text: []
      });
    }
    const loc = locations.find((l) => l.key === key);
    loc.text.push([b.summary, b.action_text].filter(Boolean).join(' '));
  }

  const charSystem = [
    'You write character bible entries for a film production pipeline from the',
    'script itself. For each character you are given every line they speak and',
    'everything they do.',
    '',
    'Each entry needs a visual_anchor: a physical description used to generate',
    'reference images. Describe appearance ONLY - build, hair, face, clothing.',
    'No personality, no backstory, no camera language. If the script never says',
    'what someone looks like, infer something plausible and consistent with how',
    'they behave, and say so in "inferred": true.',
    '',
    'Return ONLY JSON: { "characters": [ { "name": "UPPERCASE", "gender": "male|female|unknown",',
    '"visual_anchor": "...", "inferred": true|false } ] }'
  ].join('\n');

  const charUser = names.map((n) => {
    const lines = [];
    for (const b of beats) {
      for (const c of b.characters || []) if (c.name === n && c.blocking) lines.push('does: ' + c.blocking);
      for (const d of b.dialogue || []) if (d.character === n) lines.push('says: ' + d.line);
    }
    return n + '\n' + lines.slice(0, 25).join('\n');
  }).join('\n\n---\n\n');

  const locSystem = [
    'You write set descriptions for a film production pipeline. For each scene you',
    'return prose describing the EMPTY location.',
    '',
    'Never describe people. The output becomes a 360 panorama backplate that',
    'characters are composited into afterwards, so anyone described here would be',
    'permanently baked into the set.',
    '',
    'Return ONLY JSON: { "locations": [ { "act_number": 1, "scene_number": 1,',
    '"location_description": "2-4 sentences on architecture, scale, layout, materials, light",',
    '"atmosphere": "1-2 sentences on air, light quality, temperature",',
    '"set_dressing": "1-2 sentences listing props, furniture, surfaces",',
    '"sound_ambience": "1 sentence on constant background sound" } ] }'
  ].join('\n');

  const locUser = locations.map((l) =>
    `A${l.act_number}S${l.scene_number} ${l.int_ext || ''} ${l.location || ''} ${l.time_of_day || ''}\n${l.text.join(' ')}`
  ).join('\n\n---\n\n');

  // Props and wardrobe.
  //
  // A prop has no reference sheet unless someone makes one, so every render
  // invents it again - the wish star came out a different size in every shot
  // and the shadow beast rendered as two different animals. The sheet is what
  // holds it still, and the sheet needs a SCALE: "a glowing crystal" says
  // nothing about how big it is, and a model left to itself will write the
  // description and skip the size every time, so it is asked for separately.
  //
  // Aliases matter as much. Across one 23-shot draft the same object was "a
  // wish star crystal", "the crystal", "the cracked crystal" and "wish star";
  // matching on the canonical name alone bound almost nothing.
  const propSystem = [
    'You list the props and costumes a film production has to build, from the',
    'script itself. A PROP is an object characters handle or that the story turns',
    'on. WARDROBE is what a character wears that the story notices.',
    '',
    'Only things that MATTER: an object the story turns on, that is handled, or',
    'that appears in more than one scene. Not scenery, not furniture nobody',
    'touches - those belong to the set description.',
    '',
    'Never list a character as a prop.',
    '',
    'Each entry needs:',
    '- name: what the script calls it, lower case ("the wish star")',
    '- kind: "prop" or "wardrobe"',
    '- description: what it LOOKS like - shape, colour, material, condition.',
    '  Appearance only, no history and no camera language. Describe ONE state,',
    '  as it first appears. This becomes a single reference picture, so an arc',
    '  ("intact at first, then cracked, then bursting with light") cannot be',
    '  drawn and produces a muddle. If it changes later, that is a second entry.',
    '- scale_note: how big it is, against something known ("fits in a cupped',
    '  hand", "as tall as a person"). This one is required and is the whole',
    '  point: a description alone never fixes size, so the same object comes out',
    '  a different size in every shot. Never leave it empty.',
    '- aliases: every OTHER word the script uses for it. Scripts rename things',
    '  constantly - "a wish star crystal", "the crystal", "the cracked crystal".',
    '  List them all, lower case, or the description reaches none of those lines.',
    '',
    'Return ONLY JSON: { "props": [ { "name": "...", "kind": "prop|wardrobe",',
    '"description": "...", "scale_note": "...", "aliases": ["..."] } ] }'
  ].join('\n');

  // The action and the objects the breakdown already tagged, per scene - the
  // dialogue is not much use for spotting a physical object.
  const propUser = locations.map((l) => {
    const objects = [];
    for (const b of beats) {
      if (b.scene_number !== l.scene_number || b.act_number !== l.act_number) continue;
      for (const o of b.objects || []) {
        // The breakdown stores these as { name, notes }, and the notes are the
        // useful half - "a small glowing crystal that falls at Chibi's feet"
        // says far more about the object than the bare word "crystal".
        const name = typeof o === 'string' ? o : o && o.name;
        if (!name) continue;
        const notes = typeof o === 'string' ? '' : o.notes || '';
        const entry = notes ? `${name} (${notes})` : name;
        if (objects.indexOf(entry) === -1) objects.push(entry);
      }
    }
    return (
      `A${l.act_number}S${l.scene_number} ${l.location || ''}\n${l.text.join(' ')}` +
      (objects.length ? `\nobjects tagged here:\n- ${objects.join('\n- ')}` : '')
    );
  }).join('\n\n---\n\n');

  try {
    const chars = await ask(charSystem, charUser);
    const locs = await ask(locSystem, locUser);
    const props = await ask(propSystem, propUser);
    const castNames = names.map((n) => String(n).toUpperCase());
    return {
      characters: Array.isArray(chars.characters) ? chars.characters : [],
      locations: Array.isArray(locs.locations) ? locs.locations : [],
      // A model asked for objects will sometimes return a person anyway, and a
      // character written into movie_props would be described twice in every
      // prompt - once from their sheet and once as a prop.
      props: (Array.isArray(props.props) ? props.props : []).filter(
        (p) => p && p.name && castNames.indexOf(String(p.name).toUpperCase()) === -1
      ),
      beatsRead: beats.length
    };
  } catch (e) {
    return { error: 'Bible generation failed: ' + (e && e.message ? e.message : String(e)) };
  }
}

return { error: 'Unknown mode: ' + mode };
