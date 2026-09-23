// 23-Character-Bible-Writer: a conversation that maintains the character bible.
//
// It reads the movie's screenplay and its existing cast, then rewrites the whole
// bible on request. It does NOT write to the database - the writer reviews the
// result and commits it through the existing bible import, which is the one
// path that knows how to reconcile characters with what has already rendered.
const axios = require('axios');
const insforgeUrl = $insforgeUrl;
const insforgeApiKey = $insforgeApiKey;
// @include llm
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
