const gathered = JSON.parse($gatherOutput);
if (gathered.error) return { action: 'error', error: gathered.error };

if (gathered.skip) {
  return { action: 'skipped', reason: gathered.reason, characterId: gathered.characterId, characterName: gathered.characterName };
}

const extracted = { gender: $llmGender, visual_anchor: $llmVisualAnchor, clothing: $llmClothing };

const isUnknown = (v) => !v || String(v).trim().toUpperCase() === 'UNKNOWN';

if (isUnknown(extracted.visual_anchor)) {
  return {
    action: 'no_source_found',
    reason: gathered.hasSource
      ? 'source material was found but contained no usable visual description'
      : 'no bible entry, book match, or screenplay introduction was found for this character',
    sourceType: gathered.sourceType,
    characterId: gathered.characterId,
    characterName: gathered.characterName
  };
}

const axios = require('axios');
const insforgeUrl = $insforgeUrl;
const insforgeApiKey = $insforgeApiKey;
const authHeaders = { Authorization: `Bearer ${insforgeApiKey}`, 'Content-Type': 'application/json' };

const patch = {
  visual_anchor: extracted.visual_anchor,
  clothing: isUnknown(extracted.clothing) ? null : extracted.clothing,
  gender: isUnknown(extracted.gender) ? null : extracted.gender,
  visual_anchor_source: gathered.sourceType
};

await axios.patch(`${insforgeUrl}/api/database/records/characters`, patch, {
  params: { id: `eq.${gathered.characterId}` },
  headers: { ...authHeaders, Prefer: 'return=minimal' }
});

return {
  action: 'descriptor_written',
  sourceType: gathered.sourceType,
  characterId: gathered.characterId,
  characterName: gathered.characterName,
  ...patch
};
