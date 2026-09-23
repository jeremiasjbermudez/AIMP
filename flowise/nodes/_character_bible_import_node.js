// The project this run is for. The app sends `--movie <id>`; without one (a
// script, a run typed into Flowise) the active movie is used, as before.
const requestedMovieId = ((/--movie\s+([0-9a-f-]{36})/i.exec(String($flow.input || '')) || [])[1]) || '';
// Seeds the characters table for the active movie straight from its character
// bible, so a brand-new movie has characters (with descriptions) before any
// beat or orchestration run. Without this the Characters tab has nothing to
// show and no per-character action can exist yet.
//
// Bible layouts are all accepted, because requiring one would mean
// hand-reformatting every file before it could be imported:
//   A. Bracketed blocks - "[CHARACTER_BOT CHAT]" or plain "[BOT CHAT]" - each
//      normally carrying a "Visual_Anchor:" line.
//   B. Prose paragraphs, one per character: "Bot Chat (30s): A stoic, formal
//      figure with closely shaved hair..." with category headings between.
const axios = require('axios');
const insforgeUrl = $insforgeUrl;
const insforgeApiKey = $insforgeApiKey;
const authHeaders = { Authorization: `Bearer ${insforgeApiKey}` };

const rawInput = (String($flow.input || '').replace(/--movie\s+\S+/gi, '')).toString().trim();
const force = /--force\b/i.test(rawInput);

const activeRes = await axios.get(`${insforgeUrl}/api/database/records/movies`, {
  params: requestedMovieId ? { id: `eq.${requestedMovieId}`, select: 'id,bucket_name,title,slug' } : { is_active: 'eq.true', select: 'id,bucket_name,title,slug' },
  headers: authHeaders
});
const activeMovies = activeRes.data || [];
if (activeMovies.length === 0) return { error: (requestedMovieId ? `Project ${requestedMovieId} not found.` : 'No active movie set. Select one in the pipeline-admin app first.') };
if (activeMovies.length > 1) return { error: `Found ${activeMovies.length} active movies - exactly one must be active.` };
const movie = activeMovies[0];

const docRes = await axios.get(`${insforgeUrl}/api/database/records/documents`, {
  params: {
    movie_id: `eq.${movie.id}`,
    kind: 'eq.character_bible',
    select: 'id,storage_key,original_filename',
    order: 'created_at.desc',
    limit: 1
  },
  headers: authHeaders
});
const doc = (docRes.data || [])[0];
if (!doc) return { error: `No character bible uploaded for ${movie.title}. Add one on the Documents tab first.` };

const strategyRes = await axios.get(
  `${insforgeUrl}/api/storage/buckets/${movie.bucket_name}/download-strategy/objects/${encodeURIComponent(doc.storage_key)}`,
  { headers: authHeaders }
);
const strategy = strategyRes.data;
const fileHeaders = strategy.method === 'direct' ? authHeaders : {};
const fileRes = await axios.get(strategy.url, { headers: fileHeaders, responseType: 'arraybuffer' });
// utf-8 with the BOM stripped: a bible saved from Notepad carries one, and it
// would otherwise ride along inside the first character's name.
const bibleText = Buffer.from(fileRes.data).toString('utf8').replace(/^﻿/, '');

// Layout A - one block per character, opened by a bracketed marker on its own
// line. Accepts both "[CHARACTER_BOT CHAT]" (the project) and plain
// "[BOT CHAT]" (the newer bibles); requiring one or the other would mean
// hand-editing every file before it could be imported.
function parseBlocks(text) {
  const lines = text.split(/\r\n|\r|\n/);
  const markerRe = /^[ \t]*\[(?:CHARACTER_)?([A-Za-z0-9][A-Za-z0-9 '\u2019_-]*)\][ \t]*$/;
  const marks = [];
  for (let i = 0; i < lines.length; i++) {
    const m = markerRe.exec(lines[i]);
    if (m) marks.push({ name: String(m[1]).trim().toUpperCase(), line: i });
  }
  const out = [];
  for (let idx = 0; idx < marks.length; idx++) {
    const mk = marks[idx];
    const end = idx + 1 < marks.length ? marks[idx + 1].line : lines.length;
    const body = lines.slice(mk.line + 1, end).join('\n').trim();
    if (!mk.name || !body) continue;
    // The anchor line ends at a blank line or at the next "Section Title:" line.
    const a = /^Visual_Anchor:\s*([\s\S]*?)(?=\n\s*\n|\n[A-Z][A-Za-z ]*:|$)/im.exec(body);
    out.push({ name: mk.name, visualAnchor: a ? a[1].replace(/\s+/g, ' ').trim() : null });
  }
  return out;
}

// Layout B - "Name (30s): description" paragraphs. Category headings and any
// trailing chat sign-off have no "(age):" and are skipped naturally.
function parseProse(text) {
  const re = /^[ \t]*([A-Za-z][A-Za-z0-9 '’-]*?)\s*\(\s*\d+\s*s?\s*\)\s*:\s*([\s\S]*?)(?=\n\s*\n|$)/gim;
  const out = [];
  let m;
  while ((m = re.exec(text)) !== null) {
    const name = String(m[1]).trim().toUpperCase();
    const body = String(m[2]).replace(/\s+/g, ' ').trim();
    if (!name || !body) continue;
    out.push({ name, visualAnchor: body });
  }
  return out;
}

let found = parseBlocks(bibleText);
let layout = 'blocks';
if (found.length === 0) {
  found = parseProse(bibleText);
  layout = 'prose';
}

if (found.length === 0) {
  return {
    error:
      `No characters could be read from ${doc.original_filename}. Expected either a "[NAME]" or ` +
      `"[CHARACTER_NAME]" marker on its own line per character, or one paragraph each in the form ` +
      `"Bot Chat (30s): description".`
  };
}

const existingRes = await axios.get(`${insforgeUrl}/api/database/records/characters`, {
  params: { movie_id: `eq.${movie.id}`, select: 'id,name,visual_anchor,visual_anchor_source' },
  headers: authHeaders
});
const existing = existingRes.data || [];
const byName = {};
for (const c of existing) byName[String(c.name).toUpperCase()] = c;

const created = [];
const updated = [];
const skipped = [];

for (const entry of found) {
  const current = byName[entry.name];
  if (!current) {
    await axios.post(
      `${insforgeUrl}/api/database/records/characters`,
      [
        {
          movie_id: movie.id,
          name: entry.name,
          visual_anchor: entry.visualAnchor,
          visual_anchor_source: entry.visualAnchor ? 'bible' : null,
          lora_strength_model: 1,
          lora_strength_clip: 0.31
        }
      ],
      { headers: { ...authHeaders, 'Content-Type': 'application/json', Prefer: 'return=minimal' } }
    );
    created.push(entry.name);
    continue;
  }

  // Never clobber a descriptor that came from somewhere richer (a reference
  // image, say) unless the caller explicitly asked to re-import.
  const canFill = !current.visual_anchor || force || current.visual_anchor_source === 'bible';
  if (entry.visualAnchor && canFill) {
    await axios.patch(
      `${insforgeUrl}/api/database/records/characters`,
      { visual_anchor: entry.visualAnchor, visual_anchor_source: 'bible' },
      {
        params: { id: `eq.${current.id}` },
        headers: { ...authHeaders, 'Content-Type': 'application/json', Prefer: 'return=minimal' }
      }
    );
    updated.push(entry.name);
  } else {
    skipped.push(entry.name);
  }
}

return {
  action: 'imported',
  movie: movie.title,
  bible: doc.original_filename,
  layout,
  charactersInBible: found.length,
  created,
  updated,
  skipped,
  missingVisualAnchor: found.filter((f) => !f.visualAnchor).map((f) => f.name)
};
