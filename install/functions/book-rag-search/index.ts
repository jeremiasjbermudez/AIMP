// Embeds a query string via OpenRouter and matches it against book_chunks
// for one movie via the match_book_chunks RPC. Exists only because the
// OPENROUTER_API_KEY secret is stored ciphertext-only and is exclusively
// decrypted and injected into edge functions (Deno.env.get) - it can never
// be retrieved in plaintext for embedding directly into a Flowise node, so
// any RAG lookup callers (e.g. Character-Generator) must go through this
// function over HTTP instead of calling OpenRouter themselves.

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization'
};

function json(body, status) {
  return new Response(JSON.stringify(body), {
    status: status || 200,
    headers: Object.assign({}, corsHeaders, { 'Content-Type': 'application/json' })
  });
}

const EMBED_MODEL = 'openai/text-embedding-3-small';

module.exports = async function (req) {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  let movieId, queryText, matchCount, matchThreshold;
  try {
    const body = await req.json();
    movieId = typeof body.movieId === 'string' ? body.movieId : '';
    queryText = typeof body.queryText === 'string' ? body.queryText.trim() : '';
    matchCount = Number.isFinite(body.matchCount) ? body.matchCount : 5;
    matchThreshold = Number.isFinite(body.matchThreshold) ? body.matchThreshold : 0.35;
  } catch (e) {
    return json({ error: 'Invalid JSON body' }, 400);
  }

  if (!movieId) return json({ error: 'movieId is required' }, 400);
  if (!queryText) return json({ error: 'queryText is required' }, 400);

  const baseUrl = Deno.env.get('INSFORGE_INTERNAL_URL');
  const insforgeApiKey = Deno.env.get('API_KEY');
  const openrouterApiKey = Deno.env.get('OPENROUTER_API_KEY');

  if (!openrouterApiKey) {
    return json({ error: 'OPENROUTER_API_KEY secret is not configured' }, 500);
  }

  const embedRes = await fetch('https://openrouter.ai/api/v1/embeddings', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + openrouterApiKey,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ model: EMBED_MODEL, input: [queryText] })
  });
  if (!embedRes.ok) {
    const errBody = await embedRes.text();
    return json({ error: 'OpenRouter embeddings failed: ' + errBody.slice(0, 500) }, 502);
  }
  const embedJson = await embedRes.json();
  const queryEmbedding = embedJson.data[0].embedding;

  const matchRes = await fetch(baseUrl + '/api/database/rpc/match_book_chunks', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + insforgeApiKey,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      query_embedding: queryEmbedding,
      filter_movie_id: movieId,
      match_count: matchCount,
      match_threshold: matchThreshold
    })
  });
  if (!matchRes.ok) {
    const errBody = await matchRes.text();
    return json({ error: 'match_book_chunks RPC failed: ' + errBody.slice(0, 500) }, 502);
  }
  const matches = await matchRes.json();

  return json({ matches: matches });
};
