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
// @include llm
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
