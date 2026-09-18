// Deletes a movie and everything belonging to it: database rows, the InsForge
// storage bucket, and the ComfyUI input/output folders named after its slug.
//
// Input: {"movieId":"<uuid>"} to REPORT what would be deleted (the default),
//        {"movieId":"<uuid>","confirm":"<exact title>"} to actually delete.
//
// The title has to be typed back because this is irreversible and there is no
// undo - a mis-click would otherwise destroy every render for a movie.
//
// Order matters. Most tables cascade off movies, but three do not:
//   shots           - ON DELETE NO ACTION, so it BLOCKS the movie delete
//   minimax_clips   - no foreign key at all, so it would be silently orphaned
//   qwen_cleanups   - same
// Those three are removed explicitly first.
const axios = require('axios');
const insforgeUrl = $insforgeUrl;
const insforgeApiKey = $insforgeApiKey;
const comfyRoot = $comfyRoot;
const authHeaders = { Authorization: `Bearer ${insforgeApiKey}` };

let parsed;
try {
  parsed = JSON.parse(($flow.input || '').toString());
} catch (e) {
  return { error: 'Expected {"movieId":"<uuid>"} or {"movieId":"...","confirm":"<title>"}.' };
}
const movieId = parsed.movieId;
if (!movieId) return { error: 'Missing movieId.' };

const movieRes = await axios.get(`${insforgeUrl}/api/database/records/movies`, {
  params: { id: `eq.${movieId}`, select: 'id,title,slug,bucket_name,is_active' },
  headers: authHeaders
});
const movie = (movieRes.data || [])[0];
if (!movie) return { error: `No movie with id ${movieId}.` };

// ---------------------------------------------------------------- survey
const TABLES = [
  'beats', 'characters', 'documents', 'scenes', 'scene_panos', 'scene_splats',
  'screenplay_chunks', 'shots', 'minimax_clips', 'qwen_cleanups'
];
const counts = {};
for (const t of TABLES) {
  try {
    const r = await axios.get(`${insforgeUrl}/api/database/records/${t}`, {
      params: { movie_id: `eq.${movieId}`, select: 'id' },
      headers: authHeaders
    });
    counts[t] = (r.data || []).length;
  } catch (e) {
    counts[t] = -1;
  }
}

let objects = [];
try {
  const objRes = await axios.get(`${insforgeUrl}/api/storage/buckets/${movie.bucket_name}/objects`, {
    headers: authHeaders
  });
  const body = objRes.data;
  objects = (body && body.data ? body.data : body) || [];
} catch (e) {
  objects = [];
}

// Flowise runs custom functions in a sandboxed VM that blocks Node builtins
// unless TOOL_FUNCTION_BUILTIN_DEP lists them. Probe rather than assume: an
// unguarded require here takes the whole flow down with a 500 instead of
// degrading to "database and storage only".
let fs = null;
let path = null;
let fsError = null;
try {
  fs = require('fs');
  path = require('path');
} catch (e) {
  fsError = 'Filesystem access is disabled in Flowise (set TOOL_FUNCTION_BUILTIN_DEP=fs,path and restart to enable).';
}

const folders = [comfyRoot + 'input/' + movie.slug, comfyRoot + 'output/' + movie.slug];
const folderInfo = folders.map((f) => {
  if (!fs) return { path: f, exists: null, note: fsError };
  try {
    return { path: f, exists: fs.existsSync(f) };
  } catch (e) {
    return { path: f, exists: null, error: String(e.message || e) };
  }
});

const survey = {
  movie: movie.title,
  slug: movie.slug,
  isActive: movie.is_active,
  rows: counts,
  storageObjects: objects.length,
  bucket: movie.bucket_name,
  comfyFolders: folderInfo
};

// A dry run unless the exact title is typed back.
if (parsed.confirm !== movie.title) {
  return {
    action: 'dry-run',
    willDelete: survey,
    note: `Nothing was deleted. To delete, send confirm: "${movie.title}".`
  };
}

// ---------------------------------------------------------------- delete
const deleted = { rows: {}, storageObjects: 0, folders: [] };

// 1. The three that do not cascade, before the movie row.
for (const t of ['shots', 'minimax_clips', 'qwen_cleanups']) {
  try {
    await axios.delete(`${insforgeUrl}/api/database/records/${t}`, {
      params: { movie_id: `eq.${movieId}` },
      headers: authHeaders
    });
    deleted.rows[t] = counts[t];
  } catch (e) {
    return {
      action: 'error',
      stage: t,
      reason: `Could not clear ${t}: ` + (e.response ? JSON.stringify(e.response.data).slice(0, 300) : e.message),
      note: 'Nothing else was deleted - the movie is untouched.'
    };
  }
}

// 2. Storage objects, then the bucket.
for (const o of objects) {
  try {
    await axios.delete(
      `${insforgeUrl}/api/storage/buckets/${movie.bucket_name}/objects/${encodeURIComponent(o.key)}`,
      { headers: authHeaders }
    );
    deleted.storageObjects += 1;
  } catch (e) {
    /* keep going - a leftover object should not strand the whole delete */
  }
}
try {
  await axios.delete(`${insforgeUrl}/api/storage/buckets/${movie.bucket_name}`, { headers: authHeaders });
  deleted.bucket = movie.bucket_name;
} catch (e) {
  deleted.bucketError = 'Bucket not removed: ' + (e.response ? JSON.stringify(e.response.data).slice(0, 200) : e.message);
}

// 3. ComfyUI folders. Guarded: only ever a slug-named folder directly under
// input/ or output/, never a path that escapes the ComfyUI root.
if (!fs) {
  deleted.folders.push({ skipped: fsError, paths: folders });
}
for (const f of fs ? folders : []) {
  const resolved = path.resolve(f);
  const rootResolved = path.resolve(comfyRoot);
  const base = path.basename(resolved);
  if (!resolved.startsWith(rootResolved) || base !== movie.slug || !movie.slug) {
    deleted.folders.push({ path: f, skipped: 'failed the safety check' });
    continue;
  }
  try {
    if (fs.existsSync(resolved)) {
      fs.rmSync(resolved, { recursive: true, force: true });
      deleted.folders.push({ path: f, removed: true });
    } else {
      deleted.folders.push({ path: f, removed: false, note: 'did not exist' });
    }
  } catch (e) {
    deleted.folders.push({ path: f, removed: false, error: String(e.message || e) });
  }
}

// 4. The movie row last - everything else cascades off it.
try {
  await axios.delete(`${insforgeUrl}/api/database/records/movies`, {
    params: { id: `eq.${movieId}` },
    headers: authHeaders
  });
  deleted.movie = movie.title;
} catch (e) {
  return {
    action: 'error',
    stage: 'movies',
    reason: 'Could not delete the movie row: ' + (e.response ? JSON.stringify(e.response.data).slice(0, 300) : e.message),
    partial: deleted
  };
}

return { action: 'deleted', movie: movie.title, slug: movie.slug, deleted, cascaded: counts };
