const beats = JSON.parse($beatsFromLLM);
const extractResult = JSON.parse($extractOutput);
const fetchResult = JSON.parse($fetchOutput);

if (extractResult.error) return { error: extractResult.error };
if (fetchResult.error) return { error: fetchResult.error };

const { scope, movieId } = extractResult;
const screenplayLines = fetchResult.screenplayText.split(/\r\n|\r|\n/);

function sliceRawText(lineStart, lineEnd) {
  return screenplayLines.slice(lineStart - 1, lineEnd).join('\n');
}

function hashString(str) {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash + str.charCodeAt(i)) | 0;
  }
  return (hash >>> 0).toString(16);
}

const groups = new Map();
for (const beat of beats) {
  const key = beat.scene_number == null ? 'null' : String(beat.scene_number);
  if (!groups.has(key)) groups.set(key, []);
  groups.get(key).push(beat);
}

const axios = require('axios');
const authHeaders = { Authorization: `Bearer ${$insforgeApiKey}`, 'Content-Type': 'application/json' };
const results = [];

for (const [sceneKey, sceneBeats] of groups) {
  const sceneNumber = sceneKey === 'null' ? null : parseInt(sceneKey, 10);
  const groupLineStart = Math.min(...sceneBeats.map((b) => b.line_start));
  const groupLineEnd = Math.max(...sceneBeats.map((b) => b.line_end));
  const currentHash = hashString(`${$schemaVersion}::${sliceRawText(groupLineStart, groupLineEnd)}`);

  const existingParams = {
    movie_id: `eq.${movieId}`,
    act_number: `eq.${scope.act}`,
    select: 'id,source_hash'
  };
  existingParams.scene_number = sceneNumber == null ? 'is.null' : `eq.${sceneNumber}`;

  const existingRes = await axios.get(`${$insforgeUrl}/api/database/records/beats`, {
    params: existingParams,
    headers: authHeaders
  });
  const existing = existingRes.data || [];
  const existingHash = existing.length > 0 ? existing[0].source_hash : null;

  if (existing.length > 0 && existingHash === currentHash) {
    results.push({ scene: sceneNumber, action: 'skipped', reason: 'source text unchanged', beatCount: existing.length });
    continue;
  }

  if (existing.length > 0) {
    const ids = existing.map((e) => e.id);
    await axios.delete(`${$insforgeUrl}/api/database/records/beats`, {
      params: { id: `in.(${ids.join(',')})` },
      headers: authHeaders
    });
  }

  const rows = sceneBeats.map((beat, idx) => ({
    movie_id: movieId,
    sequence_index: beat.line_start,
    act_number: scope.act,
    scene_number: sceneNumber,
    beat_number: beat.beat_number ?? null,
    line_start: beat.line_start,
    line_end: beat.line_end,
    scene_heading: beat.scene_heading ?? null,
    int_ext: beat.int_ext ?? null,
    location: beat.location ?? null,
    time_of_day: beat.time_of_day ?? null,
    summary: beat.summary,
    raw_text: sliceRawText(beat.line_start, beat.line_end),
    characters: beat.characters ?? [],
    objects: beat.objects ?? [],
    dialogue: beat.dialogue ?? [],
    source_hash: currentHash
  }));

  await axios.post(`${$insforgeUrl}/api/database/records/beats`, rows, {
    headers: { ...authHeaders, Prefer: 'return=minimal' }
  });

  results.push({
    scene: sceneNumber,
    action: existing.length > 0 ? 'regenerated' : 'inserted',
    beatCount: rows.length
  });
}

return { scope, results };
