// Creates a new movie: inserts the movies row and provisions its matching
// storage bucket (movie-<slug>). Runs server-side with admin access since
// bucket creation has no SDK method at all and requires the project API key
// - the browser app must never hold that key, so this has to happen here.

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

module.exports = async function (req) {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  let title;
  try {
    const body = await req.json();
    title = typeof body.title === 'string' ? body.title.trim() : '';
  } catch (e) {
    return json({ error: 'Invalid JSON body' }, 400);
  }

  if (!title) {
    return json({ error: 'title is required' }, 400);
  }

  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

  if (!slug) {
    return json({ error: 'title must contain at least one letter or number' }, 400);
  }

  // INSFORGE_BASE_URL is the public-facing URL (localhost:7130 on the host);
  // the function runs inside the deno container, where that resolves to
  // itself, not the backend - confirmed via a real "Connection refused"
  // error. INSFORGE_INTERNAL_URL is the reserved secret meant for
  // container-to-container calls within the Docker network.
  const baseUrl = Deno.env.get('INSFORGE_INTERNAL_URL');
  const apiKey = Deno.env.get('API_KEY');
  const authHeaders = { Authorization: 'Bearer ' + apiKey, 'Content-Type': 'application/json' };

  const existingRes = await fetch(
    baseUrl + '/api/database/records/movies?slug=eq.' + encodeURIComponent(slug) + '&select=id',
    { headers: authHeaders }
  );
  const existing = existingRes.ok ? await existingRes.json() : [];
  if (Array.isArray(existing) && existing.length > 0) {
    return json({ error: 'A movie with this name already exists (slug "' + slug + '")' }, 409);
  }

  const insertRes = await fetch(baseUrl + '/api/database/records/movies', {
    method: 'POST',
    headers: Object.assign({}, authHeaders, { Prefer: 'return=representation' }),
    body: JSON.stringify([{ title: title, slug: slug }])
  });
  if (!insertRes.ok) {
    const errBody = await insertRes.text();
    return json({ error: 'Failed to create movie: ' + errBody }, 500);
  }
  const inserted = await insertRes.json();
  const movie = Array.isArray(inserted) ? inserted[0] : inserted;

  const bucketRes = await fetch(baseUrl + '/api/storage/buckets', {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({ bucketName: 'movie-' + slug, isPublic: false })
  });
  if (!bucketRes.ok) {
    const errBody = await bucketRes.text();
    // The movie row exists even though the bucket failed - surface both facts
    // rather than leaving the caller unsure whether anything was created.
    return json({ error: 'Movie row created but bucket creation failed: ' + errBody, movie: movie }, 500);
  }

  return json({ movie: movie });
};
