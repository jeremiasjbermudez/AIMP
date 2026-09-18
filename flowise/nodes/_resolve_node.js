// Sends the project's rendered clips to DaVinci Resolve.
//
// Resolve's scripting API is Python-only and its fusionscript.dll is built
// against the interpreter Resolve ships (3.13). Loading it into 3.11 or 3.12
// crashes the process outright, so the worker is pinned to Python 3.13 here -
// this is NOT the same interpreter ComfyUI and the audio separator use.
const axios = require('axios');
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const insforgeUrl = $insforgeUrl;
const insforgeApiKey = $insforgeApiKey;
const authHeaders = { Authorization: `Bearer ${insforgeApiKey}` };

const PYTHON = 'C:/Users/Alivai/AppData/Local/Programs/Python/Python313/python.exe';
const WORKER = 'C:/Flowise/resolve_job.py';

let parsed;
try {
  parsed = JSON.parse(($flow.input || '').toString());
} catch (e) {
  return { error: 'Expected JSON input.' };
}

// The payload goes via a temp file: a full clip list is far too long to pass
// safely as a shell argument.
async function runWorker(payload) {
  const dir = 'C:/Flowise/_resolve_jobs';
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'job_' + Date.now() + '.json');
  fs.writeFileSync(file, JSON.stringify(payload), 'utf8');
  return await new Promise((resolve) => {
    execFile(
      PYTHON,
      [WORKER, '@' + file],
      { cwd: 'C:/Flowise', timeout: 600000, maxBuffer: 10 * 1024 * 1024 },
      (err, stdout, stderr) => {
        const out = (stdout || '').trim();
        try {
          resolve(JSON.parse(out.split('\n').pop()));
        } catch (e) {
          resolve({
            error: out || (stderr || '').slice(-600) || (err && err.message) || 'no output from the worker'
          });
        }
      }
    );
  });
}

if (parsed.action === 'status') {
  return await runWorker({ action: 'status' });
}

// The searchable capability index, so the tab can show what Resolve can be
// asked to do rather than leaving it to guesswork.
if (parsed.action === 'capabilities') {
  return await runWorker({ action: 'capabilities', query: parsed.query || '' });
}

if (parsed.action !== 'deliver') return { error: 'Unknown action.' };
const movieId = parsed.movieId;
if (!movieId) return { error: 'Missing movieId.' };

const movieRes = await axios.get(`${insforgeUrl}/api/database/records/movies`, {
  params: { id: `eq.${movieId}`, select: 'id,title,slug' },
  headers: authHeaders
});
const movie = (movieRes.data || [])[0];
if (!movie) return { error: 'Movie not found.' };

const clipsRes = await axios.get(`${insforgeUrl}/api/database/records/minimax_clips`, {
  params: {
    movie_id: `eq.${movieId}`,
    status: 'eq.complete',
    select: 'id,mode,video_path,beat_id,length,created_at',
    order: 'created_at.asc'
  },
  headers: authHeaders
});
let clips = (clipsRes.data || []).filter((c) => c.video_path);
if (!clips.length) return { error: 'This movie has no finished clips with video.' };

// Story order, not render order: the pipeline knows which beat each clip
// belongs to, so the timeline can arrive already in screenplay sequence. That
// is the one thing an editor cannot work out for itself.
const beatIds = [...new Set(clips.map((c) => c.beat_id).filter(Boolean))];
const order = {};
if (beatIds.length) {
  const beatsRes = await axios.get(`${insforgeUrl}/api/database/records/beats`, {
    params: { id: `in.(${beatIds.join(',')})`, select: 'id,sequence_index,beat_code' },
    headers: authHeaders
  });
  for (const b of beatsRes.data || []) order[b.id] = b;
}
clips.sort((a, b) => {
  const sa = order[a.beat_id] ? order[a.beat_id].sequence_index : Number.MAX_SAFE_INTEGER;
  const sb = order[b.beat_id] ? order[b.beat_id].sequence_index : Number.MAX_SAFE_INTEGER;
  if (sa !== sb) return sa - sb;
  return String(a.created_at).localeCompare(String(b.created_at));
});

// Post-voice output supersedes the raw clip: if a clip has been re-voiced, the
// re-voiced file is what belongs on the timeline.
const vrRes = await axios.get(`${insforgeUrl}/api/database/records/voice_replacements`, {
  params: { movie_id: `eq.${movieId}`, status: 'eq.complete', select: 'clip_id,output_path,created_at', order: 'created_at.asc' },
  headers: authHeaders
});
const revoiced = {};
for (const v of vrRes.data || []) {
  if (v.clip_id && v.output_path) revoiced[v.clip_id] = v.output_path;
}

const payload = {
  action: 'deliver',
  projectName: parsed.projectName || movie.title,
  timeline: parsed.timeline !== false,
  fps: 24,
  clips: clips.map((c) => ({
    path: revoiced[c.id] || c.video_path,
    beat: order[c.beat_id] ? order[c.beat_id].beat_code : null,
    revoiced: !!revoiced[c.id]
  }))
};

const result = await runWorker(payload);
if (!result || result.error) {
  return { action: 'error', reason: (result && result.error) || 'The worker produced no result.' };
}
return {
  action: 'complete',
  ...result,
  revoicedUsed: Object.keys(revoiced).length,
  orderedByBeat: beatIds.length > 0
};
