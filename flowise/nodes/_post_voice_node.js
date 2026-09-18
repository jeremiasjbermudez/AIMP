// Post Voice: replace the voice in a rendered clip without re-rendering it.
//
// Two actions on one flow so the tab needs only one endpoint:
//   {"action":"voices"}                    -> the voices on the ElevenLabs account
//   {"action":"convert","replacementId":…} -> do the job for one queued row
//
// The heavy lifting (separation model, ffmpeg, ElevenLabs) lives in
// post_voice_job.py; this node only resolves rows and shells out to it. The key
// never reaches the browser: it is read server-side by that script.
const axios = require('axios');
const { execFile } = require('child_process');
const fs = require('fs');
const insforgeUrl = $insforgeUrl;
const insforgeApiKey = $insforgeApiKey;
const authHeaders = { Authorization: `Bearer ${insforgeApiKey}` };

let parsed;
try {
  parsed = JSON.parse(($flow.input || '').toString());
} catch (e) {
  return { error: 'Expected JSON input.' };
}

function elevenKey() {
  const env = fs.readFileSync('C:/Flowise/.env', 'utf8');
  const line = env.split(/\r?\n/).find((l) => l.startsWith('ELEVENLABS_API_KEY='));
  if (!line) throw new Error('ELEVENLABS_API_KEY not set in C:/Flowise/.env');
  return line.split('=').slice(1).join('=').trim();
}

// --- list the voices, so the tab can offer them without holding the key ------
if (parsed.action === 'voices') {
  try {
    const res = await axios.get('https://api.elevenlabs.io/v1/voices', {
      headers: { 'xi-api-key': elevenKey() }
    });
    const voices = (res.data.voices || []).map((v) => ({
      id: v.voice_id,
      name: v.name,
      gender: (v.labels || {}).gender || '',
      accent: (v.labels || {}).accent || ''
    }));
    return { voices };
  } catch (e) {
    const body = (e && e.response && e.response.data) || (e && e.message) || String(e);
    return { error: 'Could not list voices: ' + JSON.stringify(body).slice(0, 400) };
  }
}

if (parsed.action !== 'convert') return { error: 'Unknown action.' };
const replacementId = parsed.replacementId;
if (!replacementId) return { error: 'Missing replacementId.' };

const rowRes = await axios.get(`${insforgeUrl}/api/database/records/voice_replacements`, {
  params: { id: `eq.${replacementId}`, select: '*' },
  headers: authHeaders
});
const row = (rowRes.data || [])[0];
if (!row) return { error: `No voice replacement found with id ${replacementId}.` };

async function update(patch) {
  await axios.patch(`${insforgeUrl}/api/database/records/voice_replacements`, patch, {
    params: { id: `eq.${replacementId}` },
    headers: { ...authHeaders, 'Content-Type': 'application/json', Prefer: 'return=minimal' }
  });
}

const movieRes = await axios.get(`${insforgeUrl}/api/database/records/movies`, {
  params: { id: `eq.${row.movie_id}`, select: 'slug,bucket_name' },
  headers: authHeaders
});
const movie = (movieRes.data || [])[0];
if (!movie) return { error: 'Movie not found.' };

// The source is either a clip that has already rendered, or a video the user
// picked off their own disk and uploaded.
let sourcePath;
if (row.source_key) {
  await update({ status: 'running', error_message: null });
  try {
    const url = `${insforgeUrl}/api/storage/buckets/${movie.bucket_name}/objects/${row.source_key}`;
    const res = await axios.get(url, { headers: authHeaders, responseType: 'arraybuffer' });
    const dir = 'C:/Flowise/_voice_post/uploads';
    fs.mkdirSync(dir, { recursive: true });
    const ext = (String(row.source_filename || '').split('.').pop() || 'mp4').replace(/[^a-zA-Z0-9]/g, '') || 'mp4';
    sourcePath = `${dir}/${replacementId}.${ext}`;
    fs.writeFileSync(sourcePath, Buffer.from(res.data));
  } catch (e) {
    const msg = 'Could not fetch the uploaded video: ' + (e && e.message ? e.message : String(e));
    await update({ status: 'failed', error_message: msg });
    return { action: 'error', reason: msg };
  }
} else {
  const clipRes = await axios.get(`${insforgeUrl}/api/database/records/minimax_clips`, {
    params: { id: `eq.${row.clip_id}`, select: 'id,video_path' },
    headers: authHeaders
  });
  const clip = (clipRes.data || [])[0];
  if (!clip || !clip.video_path) {
    const msg = 'The chosen clip has no rendered video.';
    await update({ status: 'failed', error_message: msg });
    return { action: 'error', reason: msg };
  }
  sourcePath = clip.video_path;
  await update({ status: 'running', error_message: null });
}

// Written under ComfyUI's output/ so the tab can preview it through the same
// /view endpoint every other rendered file uses.
const outRel = 'output/' + movie.slug + '/_post_voice/' + replacementId + '.mp4';

const payload = JSON.stringify({
  clipPath: sourcePath,
  voiceId: row.voice_id,
  outPath: outRel,
  gain: row.gain || 2.0
});

const result = await new Promise((resolve) => {
  execFile(
    'python',
    ['C:/Flowise/post_voice_job.py', payload],
    // Separation loads a ~640MB model; the whole job is minutes, not seconds.
    { cwd: 'C:/Flowise', timeout: 1800000, maxBuffer: 10 * 1024 * 1024 },
    (err, stdout, stderr) => {
      const out = (stdout || '').trim();
      try {
        resolve(JSON.parse(out.split('\n').pop()));
      } catch (e) {
        resolve({ error: (out || (stderr || '').slice(-600) || (err && err.message) || 'no output from the job') });
      }
    }
  );
});

if (!result || result.error) {
  const msg = (result && result.error) || 'The job produced no result.';
  await update({ status: 'failed', error_message: String(msg).slice(0, 1500) });
  return { action: 'error', reason: msg };
}

await update({
  status: 'complete',
  output_path: result.outputPath,
  timing_match: result.timingMatch,
  error_message: null
});
return {
  action: 'complete',
  replacementId,
  outputPath: result.outputPath,
  timingMatch: result.timingMatch,
  seconds: result.seconds
};
