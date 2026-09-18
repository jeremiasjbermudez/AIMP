// 45-Splat-Camera: survey a room, name what is in it, place shots, render plates.
//
// A thin wrapper around _splat_camera.py. The work is in the Python because it
// needs torch and gsplat - neither of which exists in Flowise's sandbox - and
// because the pack's own VNCCS_PLYSceneRenderer can only put a camera at the
// centre of a room, which cannot express coverage.
//
// The same shelling pattern 42-Shot-Breakdown uses: spawn with shell:true so the
// interpreter resolves on Windows, and every argument quoted because a shell
// re-splits the command line on spaces.
//
// Input:  {"mode":"survey","movieId":"...","act":1,"scene":2}
//         {"mode":"landmarks","planId":"...","set":{"desk":0,"door":140},"center":["desk"]}
//         {"mode":"seed","directorPlanId":"...","scene":2,"lookAt":"desk","from":"door","lineSide":"fire"}
//         {"mode":"render","planId":"...","shot":9}
// Output: {"action":"<mode>","log":"...","planId":"..."}
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const PYTHON = 'C:/Users/Alivai/AppData/Local/Programs/Python/Python312/python.exe';
const SCRIPT = 'C:/Flowise/_splat_camera.py';
// Sharpening is a different tool: it writes a camera path through a shot and
// renders it, so the world builder has something new to expand from. It lives
// in its own script because it imports the HY-World pack, which the camera
// tool deliberately does not.
const SHARPEN_SCRIPT = 'C:/Flowise/_shot_trajectories.py';

let parsed;
try {
  parsed = JSON.parse(($flow.input || '').toString());
} catch (e) {
  return { error: 'Expected JSON, e.g. {"mode":"survey","movieId":"...","act":1,"scene":2}' };
}

const mode = String(parsed.mode || '').trim();
if (!['survey', 'landmarks', 'seed', 'render', 'plys', 'sharpen'].includes(mode)) {
  return { error: `mode must be survey, landmarks, seed, render, plys or sharpen - got ${mode || '(none)'}` };
}
const TOOL = mode === 'sharpen' ? SHARPEN_SCRIPT : SCRIPT;
if (!fs.existsSync(TOOL)) return { error: 'The camera tool is missing: ' + TOOL };
if (!fs.existsSync(PYTHON)) return { error: 'Python is not where this flow expects it: ' + PYTHON };

// -X utf8 because the tool prints degree signs, and Windows' default codepage
// turns those into a UnicodeEncodeError that kills the run mid-survey.
const args = mode === 'sharpen' ? ['-X', 'utf8', TOOL] : ['-X', 'utf8', TOOL, mode];

if (mode === 'survey') {
  if (!parsed.movieId) return { error: 'survey needs a movieId.' };
  args.push('--movie', String(parsed.movieId), '--act', String(parsed.act || 1), '--scene', String(parsed.scene));
  if (parsed.ply) args.push('--ply', String(parsed.ply));
  if (parsed.world) args.push('--world', String(parsed.world));
} else if (mode === 'landmarks') {
  if (!parsed.planId) return { error: 'landmarks needs a planId.' };
  const set = parsed.set || {};
  const names = Object.keys(set);
  if (!names.length) return { error: 'landmarks needs at least one name, e.g. {"set":{"door":140}}' };
  args.push('--plan', String(parsed.planId));
  for (const n of names) args.push('--set', `${n}=${Number(set[n])}`);
  for (const n of parsed.center || []) args.push('--center', String(n));
} else if (mode === 'sharpen') {
  if (!parsed.planId || !parsed.directorPlanId) return { error: 'sharpen needs a planId (floor plan) and a directorPlanId.' };
  args.push('--plan', String(parsed.planId), '--director-plan', String(parsed.directorPlanId), '--render');
  if (parsed.shot) args.push('--shot', String(Number(parsed.shot)));
} else if (mode === 'plys') {
  if (!parsed.movieId) return { error: 'plys needs a movieId.' };
  args.push('--movie', String(parsed.movieId));
} else if (mode === 'seed') {
  if (!parsed.directorPlanId) return { error: 'seed needs a directorPlanId.' };
  args.push('--director-plan', String(parsed.directorPlanId), '--scene', String(parsed.scene));
  if (parsed.lookAt) args.push('--look-at', String(parsed.lookAt));
  if (parsed.from) args.push('--from-landmark', String(parsed.from));
  if (parsed.lineSide) args.push('--line-side', String(parsed.lineSide));
} else {
  if (!parsed.planId) return { error: 'render needs a planId.' };
  args.push('--plan', String(parsed.planId));
  if (parsed.shot) args.push('--shot', String(Number(parsed.shot)));
}

// No timeout. A survey loads a 138 MB splat and renders eighteen views; a render
// of every shot in a scene loads it once and renders in fractions of a second.
// A wall-clock cap here would be a guess, and killing a survey that needed one
// more second throws the whole thing away.
const run = await new Promise((resolve) => {
  const quoted = args.map((a) => '"' + String(a).split('"').join('') + '"');
  const p = spawn(PYTHON, quoted, { windowsHide: true, shell: true });
  let out = '';
  let err = '';
  p.stdout.on('data', (d) => (out += d.toString()));
  p.stderr.on('data', (d) => (err += d.toString()));
  p.on('error', (e) => resolve({ code: -1, out, err: String(e && e.message) }));
  p.on('close', (code) => resolve({ code, out, err }));
});

if (run.code !== 0) {
  // The tool exits with a sentence, not a stack, for everything it expects to go
  // wrong - no splat on disk, landmarks not named yet. That sentence is the
  // useful part, so it is what comes back rather than "exit code 1".
  const said = (run.err || run.out || '').trim();
  return {
    action: 'error',
    mode,
    reason: said.split('\n').filter(Boolean).slice(-1)[0] || 'The camera tool failed.',
    detail: said.slice(-1200),
    exitCode: run.code
  };
}

// survey prints the id of the plan it wrote; the caller needs it to name
// landmarks and to render, so it is lifted out rather than left in the log.
const planId = (run.out.match(/floor plan ([0-9a-f-]{36})/i) || [])[1] || parsed.planId || null;

// plys answers with JSON on stdout rather than a log to read.
if (mode === 'plys') {
  try {
    return { action: mode, ...JSON.parse(run.out.trim()) };
  } catch (e) {
    return { action: 'error', mode, reason: 'The splat list was not valid JSON.', detail: run.out.slice(-800) };
  }
}

return {
  action: mode,
  planId,
  log: run.out.trim().slice(-4000)
};
