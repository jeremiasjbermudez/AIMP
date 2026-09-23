// Face QA: score a rendered clip's face against a character's reference images.
//
// Measurement only - it never edits a clip. The repair half is a separate job,
// deliberately, so drift can be found and quantified before anything is changed.
//
// Runs on ComfyUI's interpreter (3.12): that is the one with insightface and the
// buffalo_l models already on disk. NOT the 3.13 that DaVinci Resolve needs.
const axios = require('axios');
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const insforgeUrl = $insforgeUrl;
const insforgeApiKey = $insforgeApiKey;
const authHeaders = { Authorization: `Bearer ${insforgeApiKey}` };

// ComfyUI's own Python (COMFY_PYTHON in install.env), and the worker from this
// repository, found beside the installer: no machine's paths written in here.
const PYTHON = String($comfyPython || 'python');
const WORKER = path.join(String($installRoot || ''), '..', 'flowise', 'workers', 'face_qa_job.py');
const COMFY_ROOT = String($comfyRoot || '');

// The qa_* shots exist precisely for this job: head-and-shoulders, whole head in
// frame, faces around 320px that score 0.69-0.90 against each other. The older
// closeup/portrait/uppertorso set measures 143-164px and the closeup often
// fails detection outright, so scoring against those was comparing a clip to
// the worst references the character has rather than the ones built for it.
//
// It matters more than "a bit noisier" because the worker averages every
// reference embedding into ONE centroid (face_qa_job.py, np.mean over vecs). A
// weak reference does not merely fail to help - it pulls the centroid away from
// the character, and every frame is then measured against that.
//
// A turnaround or full body puts the head at ~50px, below what the recogniser
// can identify at all, so neither list includes them.
const QA_KINDS = ['qa_front', 'qa_threequarter_left', 'qa_threequarter_right', 'qa_low_angle'];
const LEGACY_KINDS = ['closeup', 'portrait', 'uppertorso'];
const FACE_KINDS = QA_KINDS.concat(LEGACY_KINDS);

let parsed;
try {
  parsed = JSON.parse(($flow.input || '').toString());
} catch (e) {
  return { error: 'Expected JSON input {"clipId":"...","characterId":"..."}' };
}

async function runWorker(payload) {
  const dir = path.join(require('os').tmpdir(), 'aimp-face-qa');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'qa_' + Date.now() + '.json');
  // Clip and reference paths are relative to ComfyUI's folder.
  fs.writeFileSync(file, JSON.stringify(Object.assign({ comfyRoot: COMFY_ROOT }, payload)), 'utf8');
  return await new Promise((resolve) => {
    execFile(
      PYTHON,
      [WORKER, '@' + file],
      { cwd: path.dirname(WORKER), timeout: 900000, maxBuffer: 20 * 1024 * 1024 },
      (err, stdout, stderr) => {
        const out = (stdout || '').trim();
        try {
          // insightface prints model-loading chatter to stdout, so the JSON is
          // the last line rather than the whole of it.
          resolve(JSON.parse(out.split('\n').pop()));
        } catch (e) {
          resolve({
            error: out.slice(-500) || (stderr || '').slice(-500) || (err && err.message) || 'no output from the worker'
          });
        }
      }
    );
  });
}

if (parsed.action === 'probe') return await runWorker({ action: 'probe' });

const clipId = parsed.clipId;
const characterId = parsed.characterId;
if (!clipId) return { error: 'Pick a clip to score.' };
if (!characterId) return { error: 'Pick which character should be in this clip.' };

const clipRes = await axios.get(`${insforgeUrl}/api/database/records/minimax_clips`, {
  params: { id: `eq.${clipId}`, select: 'id,video_path,status,length,width,height,beat_id' },
  headers: authHeaders
});
const clip = (clipRes.data || [])[0];
if (!clip) return { error: 'Clip not found.' };
if (!clip.video_path) return { error: 'That clip has no rendered video to score.' };

const charRes = await axios.get(`${insforgeUrl}/api/database/records/characters`, {
  params: { id: `eq.${characterId}`, select: 'id,name,face_covered' },
  headers: authHeaders
});
const character = (charRes.data || [])[0];
if (!character) return { error: 'Character not found.' };

// A character who is never seen unmasked has no reference face to match, so
// this runs BEFORE references are gathered - requiring one would reject exactly
// the characters this branch exists for. The test inverts: a DETECTED face is
// the defect, because it means the renderer took the mask off.
if (character.face_covered) {
  const seen = await runWorker({
    action: 'detect',
    video: clip.video_path,
    everyNth: Number(parsed.everyNth) || 8,
    maxFrames: Number(parsed.maxFrames) || 40
  });
  if (!seen || seen.error) {
    return { action: 'error', character: character.name, reason: (seen && seen.error) || 'No result.' };
  }
  const n = seen.uncoveredFrames || 0;
  const first = n && seen.uncovered && seen.uncovered.length ? seen.uncovered[0].time : null;
  return {
    action: 'complete',
    mode: 'covered',
    character: character.name,
    clipId: clip.id,
    uncoveredFrames: n,
    coveredFrames: seen.coveredFrames,
    sampled: seen.sampled,
    framesScanned: seen.framesScanned,
    firstUncoveredAt: first,
    uncovered: seen.uncovered,
    // Deliberately not asserting whose face it is. Detection finds A face, not
    // THE character - in a two-hander with one masked and one unmasked actor it
    // will fire on the other person. Reporting what was seen and letting the
    // operator judge is honest; claiming the clip is wrong is not.
    verdict: n > 0 ? 'uncovered face found' : 'stayed covered',
    note:
      n > 0
        ? `An uncovered face appears in ${n} of ${seen.sampled} sampled frames` +
          (first !== null ? `, first at ${first}s` : '') +
          `. If ${character.name} is alone in this shot, the mask came off. If another ` +
          `character is on screen it may be theirs - this checks for a face, not whose.`
        : `No uncovered face in ${seen.sampled} sampled frames. Nothing in this clip ` +
          `shows an identifiable face, which is what you want for ${character.name}.`
  };
}

const imgRes = await axios.get(`${insforgeUrl}/api/database/records/character_images`, {
  params: {
    character_id: `eq.${characterId}`,
    select: 'kind,image_path,version',
    order: 'version.desc'
  },
  headers: authHeaders
});
const all = (imgRes.data || []).filter((r) => r.image_path);
// Prefer the purpose-built set. Two or more qa_* shots make a centroid on their
// own; below that, fall back to the legacy kinds rather than trusting a
// single view.
const qaRefs = all.filter((r) => QA_KINDS.indexOf(r.kind) >= 0);
const legacyRefs = all.filter((r) => LEGACY_KINDS.indexOf(r.kind) >= 0);
const chosen = qaRefs.length >= 2 ? qaRefs : qaRefs.concat(legacyRefs);
const refKindsUsed = chosen.map((r) => r.kind);
let refs = chosen.map((r) => r.image_path);
// Fall back to everything rather than refusing outright: the worker measures
// each reference and reports which ones it could not use.
if (!refs.length) refs = all.map((r) => r.image_path);
if (!refs.length) {
  return { error: `${character.name} has no reference images yet. Generate or upload some on the Characters tab first.` };
}

const result = await runWorker({
  action: 'score',
  video: clip.video_path,
  references: refs,
  everyNth: Number(parsed.everyNth) || 8,
  maxFrames: Number(parsed.maxFrames) || 40
});

if (!result || result.error) {
  return {
    action: 'error',
    character: character.name,
    reason: (result && result.error) || 'The worker produced no result.',
    referencesTried: refs.length,
    skipped: (result && result.skipped) || [],
    // A wide shot legitimately has no scorable face. Saying so is more useful
    // than reporting a number that means nothing.
    hint: 'No face large enough to identify. This is normal for a wide shot - score a closer clip.'
  };
}

const worst = result.worst || {};
return {
  action: 'complete',
  character: character.name,
  clipId: clip.id,
  // The headline is the WORST sampled frame, not the mean: drift is usually a
  // short stretch, and an average over the clip hides exactly that.
  worst: worst.similarity,
  worstAtSeconds: worst.time,
  worstAtFrame: worst.frame,
  mean: result.mean,
  best: result.best && result.best.similarity,
  sampled: result.sampled,
  framesScanned: result.framesScanned,
  framesRejected: result.framesWithNoFace,
  fps: result.fps,
  referencesUsed: result.referencesUsed,
  referenceKinds: refKindsUsed,
  referencesSkipped: result.referencesSkipped,
  frames: result.frames
};