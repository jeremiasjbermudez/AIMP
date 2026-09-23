const resolved = JSON.parse($resolveOutput);
if (resolved.error) return { error: resolved.error };

const { movieId, movieTitle, bucketName, characterId, characterName, existingCharacter } = resolved;

const axios = require('axios');
const insforgeUrl = $insforgeUrl;
const insforgeApiKey = $insforgeApiKey;
const ollamaBaseUrl = $ollamaBaseUrl;
const ollamaModel = $ollamaModel;
const authHeaders = { Authorization: `Bearer ${insforgeApiKey}` };

if (existingCharacter && existingCharacter.visual_anchor) {
  const refImageRes = await axios.get(`${insforgeUrl}/api/database/records/documents`, {
    params: { character_id: `eq.${characterId}`, kind: 'eq.character_reference_image', select: 'id', limit: 1 },
    headers: authHeaders
  });
  const hasPendingRefImage = (refImageRes.data || []).length > 0 && existingCharacter.visual_anchor_source !== 'reference_image';
  if (!hasPendingRefImage) {
    return { skip: true, reason: 'visual_anchor already set', hasSource: false, sourceType: null, source: null, characterId, characterName, movieId, movieTitle, bucketName };
  }
}

let sourceText = null;
let sourceType = null;

const bibleDocsRes = await axios.get(`${insforgeUrl}/api/database/records/documents`, {
  params: { movie_id: `eq.${movieId}`, kind: 'eq.character_bible', select: 'id,storage_key' },
  headers: authHeaders
});
const bibleDocs = bibleDocsRes.data || [];

if (bibleDocs.length > 0) {
  const doc = bibleDocs[0];
  const key = encodeURIComponent(doc.storage_key);
  const strategyRes = await axios.get(`${insforgeUrl}/api/storage/buckets/${bucketName}/download-strategy/objects/${key}`, {
    headers: authHeaders
  });
  const strategy = strategyRes.data;
  const fileHeaders = strategy.method === 'direct' ? authHeaders : {};
  const fileRes = await axios.get(strategy.url, { headers: fileHeaders, transformResponse: (r) => r });
  const bibleText = fileRes.data;

  const markerRegex = new RegExp(`\\[CHARACTER_${characterName}\\]([\\s\\S]*?)(?=\\n\\[CHARACTER_|$)`, 'i');
  const match = markerRegex.exec(bibleText);
  if (match && match[1].trim().length > 0) {
    sourceText = match[1].trim();
    sourceType = 'bible';
  } else if (!/\[CHARACTER_[A-Z0-9_]+\]/i.test(bibleText)) {
    sourceText = bibleText;
    sourceType = 'bible_unstructured';
  }
}

if (!sourceText) {
  const refImageRes = await axios.get(`${insforgeUrl}/api/database/records/documents`, {
    params: { character_id: `eq.${characterId}`, kind: 'eq.character_reference_image', select: 'id,storage_key', limit: 1 },
    headers: authHeaders
  });
  const refImages = refImageRes.data || [];
  if (refImages.length > 0) {
    const doc = refImages[0];
    const key = encodeURIComponent(doc.storage_key);
    const strategyRes = await axios.get(`${insforgeUrl}/api/storage/buckets/${bucketName}/download-strategy/objects/${key}`, {
      headers: authHeaders
    });
    const strategy = strategyRes.data;
    const fileHeaders = strategy.method === 'direct' ? authHeaders : {};
    const imageRes = await axios.get(strategy.url, { headers: fileHeaders, responseType: 'arraybuffer' });
    const imageBase64 = Buffer.from(imageRes.data).toString('base64');

    const visionRes = await axios.post(`${ollamaBaseUrl}/api/chat`, {
      model: ollamaModel,
      messages: [
        {
          role: 'user',
          content: `Describe this person's physical appearance and clothing in detail - hair, build, face, apparent age, distinguishing features, and what they are wearing. This is for ${characterName}, a character in a film. Only describe what is visibly present in the image, do not invent details.`,
          images: [imageBase64]
        }
      ],
      stream: false,
      think: false,
      options: { keep_alive: '0' }
    });
    const description = visionRes.data && visionRes.data.message && visionRes.data.message.content;
    if (description && description.trim().length > 0) {
      sourceText = description.trim();
      sourceType = 'reference_image';
    }
  }
}

if (!sourceText) {
  try {
    const beatsRes = await axios.get(`${insforgeUrl}/api/database/records/beats`, {
      params: { movie_id: `eq.${movieId}`, order: 'sequence_index.asc', select: 'raw_text,characters' },
      headers: authHeaders
    });
    const beats = beatsRes.data || [];
    const introBeat = beats.find((b) => (b.characters || []).some((c) => c.name === characterName && c.presence === 'in_scene'));
    if (introBeat) {
      sourceText = introBeat.raw_text;
      sourceType = 'screenplay_intro';
    }
  } catch (e) {
    // beats table may not exist yet for a fresh movie - not fatal, fall through
  }
}

if (!sourceText) {
  try {
    const ragRes = await axios.post(
      `${insforgeUrl}/functions/book-rag-search`,
      {
        movieId,
        queryText: `${characterName} physical appearance, clothing, and visual description`,
        matchCount: 5,
        matchThreshold: 0.35
      },
      { headers: { ...authHeaders, 'Content-Type': 'application/json' } }
    );
    const matches = (ragRes.data && ragRes.data.matches) || [];
    if (matches.length > 0) {
      sourceText = matches.map((m) => m.content).join('\n\n---\n\n');
      sourceType = 'book_rag';
    }
  } catch (e) {}
}

return {
  skip: false,
  hasSource: !!sourceText,
  sourceType,
  source: sourceText,
  characterId,
  characterName,
  movieId,
  movieTitle,
  bucketName
};
