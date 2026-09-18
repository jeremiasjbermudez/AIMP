// 42-Shot-Breakdown: the Tools tab's way into _shot_breakdown.js.
//
// It SHELLS OUT to the script rather than reimplementing it. There is one copy of
// the cut detection, the frame extraction and the describing instruction, and it
// is the file you can also run from a terminal. Two copies of this would drift
// within a week - the terminal one would get the fix and the tab would quietly
// keep the bug, which is how the wardrobe rule ended up living in three places.
//
// Input:  {"videoPath":"C:/video/mall.mp4","threshold":0.3,"describe":true}
// Output: {"action":"broken_down","shots":[...],"outDir":"..."}
const axios = require('axios');
// Declared because the cast lookup below needs them. They were used without
// being declared, which threw a ReferenceError straight into a silent catch:
// the cast file was never written, the screenplay kept its made-up labels, and
// nothing anywhere said why.
const insforgeUrl = $insforgeUrl;
const insforgeApiKey = $insforgeApiKey;
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

let parsed;
try {
  parsed = JSON.parse(($flow.input || '').toString());
} catch (e) {
  return { error: 'Expected JSON {"videoPath":"C:/path/to/video.mp4"}' };
}
// ------------------------------------------------------------------ choose
//
// The real Windows file dialog, opened on this machine.
//
// A browser cannot give you a path - `<input type="file">` hands over bytes and a
// bare filename by design, and no amount of asking changes that. But Flowise runs
// on the same machine you are sitting at, so it can open the actual dialog: you
// pick a file the way you pick a file, and the path comes back.
//
// -STA because the file dialog is a COM component and will not open on a
// multi-threaded apartment. It blocks until you choose or cancel, which is
// correct - there is nothing to do until then.
if (String(parsed.mode || '') === 'choose') {
  const ps = [
    'Add-Type -AssemblyName System.Windows.Forms',
    '$d = New-Object System.Windows.Forms.OpenFileDialog',
    // Pick a breakdown instead of a film when asked to - the same dialog
    // serves both, and a second one would be a second thing to keep working.
    String(parsed.want || '') === 'shots'
      ? '$d.Filter = "Breakdown|shots.json|JSON|*.json|All files|*.*"'
      : '$d.Filter = "Video files|*.mp4;*.mov;*.mkv;*.avi;*.m4v;*.webm;*.mpg;*.mpeg;*.wmv;*.ts;*.m2ts;*.mxf|All files|*.*"',
    String(parsed.want || '') === 'shots' ? '$d.Title = "Choose a breakdown (shots.json)"' : '$d.Title = "Choose a video"',
    // On top of everything, because it opens behind the browser otherwise and
    // looks like the button did nothing.
    '$d.ShowHelp = $false',
    'if ($d.ShowDialog((New-Object System.Windows.Forms.Form -Property @{TopMost=$true})) -eq [System.Windows.Forms.DialogResult]::OK) { Write-Output $d.FileName }'
  ].join('; ');

  const picked = await new Promise((resolve) => {
    const p = spawn('powershell', ['-NoProfile', '-STA', '-Command', ps], { windowsHide: true });
    let out = '';
    p.stdout.on('data', (d) => (out += d.toString()));
    p.on('error', () => resolve(''));
    p.on('close', () => resolve(out.trim()));
  });

  // Cancelled is not an error. It is a person changing their mind.
  if (!picked) return { action: 'cancelled' };
  return { action: 'chose', videoPath: picked.split('\\').join('/') };
}

// ------------------------------------------------------------------- reveal
//
// Open the output folder in Explorer, on this machine.
//
// The breakdown ends with frames and two text files on disk, and printing the
// path meant selecting it, copying it and pasting it into Explorer to see any of
// it. Same reasoning as the file dialog: the browser cannot open a folder, but
// the machine Flowise runs on is the machine you are sitting at.
if (String(parsed.mode || '') === 'reveal') {
  const dir = String(parsed.dir || '').trim();
  if (!dir || !fs.existsSync(dir)) return { error: 'That folder is not there any more.' };
  spawn('explorer', ['"' + dir.split('/').join('\\') + '"'], { windowsHide: true, shell: true });
  // Explorer returns a non-zero exit code even when it opens the window, so
  // nothing is checked here - there is no signal worth reading.
  return { action: 'revealed', dir };
}

// --------------------------------------------------------------- screenplay
//
// Turn a finished breakdown into a screenplay. Separate from the breakdown
// itself because it is a separate decision: you look at the shots first, decide
// the cuts were found properly, and only then ask for a script of them.
//
// The text comes back with the result so the tab can hand it straight to you -
// a browser cannot read a file off this disk, but it can save one it was given.
if (String(parsed.mode || '') === 'screenplay') {
  const shotsJson = String(parsed.shotsJson || '').trim();
  if (!shotsJson || !fs.existsSync(shotsJson)) {
    return { error: 'Run a breakdown first - this builds a screenplay from its shots.json.' };
  }
  const SP = 'C:/Flowise/_screenplay_from_shots.js';
  if (!fs.existsSync(SP)) return { error: 'The screenplay script is missing at ' + SP };

  const a = [SP, shotsJson];
  let castError = null;
  // Names you supply, as NAME=clue. You know the cast; this only has pictures.
  if (String(parsed.cast || '').trim()) a.push('--cast', String(parsed.cast).trim());
  if (String(parsed.title || '').trim()) a.push('--title', String(parsed.title).trim());

  // The movie's own characters, so the groups can be named after them rather
  // than after what they look like. Written to a file beside the breakdown
  // because an anchor is a paragraph and several of them do not belong on a
  // command line.
  if (String(parsed.movieId || '').trim()) {
    try {
      const r0 = await axios.get(`${insforgeUrl}/api/database/records/characters`, {
        params: { movie_id: `eq.${parsed.movieId}`, select: 'name,visual_anchor' },
        headers: { Authorization: `Bearer ${insforgeApiKey}` }
      });
      const rows = (r0.data || []).filter((c) => c && c.name);
      if (rows.length) {
        const cf = path.join(path.dirname(shotsJson), 'filmcast.json');
        fs.writeFileSync(
          cf,
          JSON.stringify(rows.map((c) => ({ name: String(c.name).toUpperCase(), anchor: c.visual_anchor || '' })))
        );
        a.push('--castfile', cf);
      }
    } catch (e) {
      // Not fatal - the labels stay generic and the manual field still works -
      // but SAID, because a silent catch here is what hid the missing variables.
      castError = e && e.message ? e.message : String(e);
    }
  }

  const r = await new Promise((resolve) => {
    // Quoted, for the same reason the breakdown's arguments are: shell:true
    // re-splits on spaces and every real filename has them.
    const q = a.map((x) => '"' + String(x).split('"').join('') + '"');
    const p = spawn('node', q, { windowsHide: true, shell: true });
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => (out += d.toString()));
    p.stderr.on('data', (d) => (err += d.toString()));
    p.on('error', (e) => resolve({ code: -1, out, err: String(e && e.message) }));
    p.on('close', (code) => resolve({ code, out, err }));
  });

  const dir = path.dirname(shotsJson);
  const txt = path.join(dir, 'screenplay.txt');
  const js = path.join(dir, 'screenplay.json');
  if (!fs.existsSync(js)) {
    return { error: 'The screenplay was not written.', detail: (r.err || r.out || '').slice(-800), exitCode: r.code };
  }
  const built = JSON.parse(fs.readFileSync(js, 'utf8'));
  return {
    action: 'screenplay',
    dir,
    textPath: txt,
    jsonPath: js,
    title: built.title,
    cast: built.cast || [],
    scenes: (built.scenes || []).map((sc) => ({
      scene: sc.scene,
      heading: `${sc.int_ext}. ${sc.location} - ${sc.time_of_day}`,
      beats: (sc.beats || []).length,
      lines: (sc.beats || []).reduce((n, b) => n + (b.dialogue || []).length, 0)
    })),
    // The whole script, so the tab can save it without reading the disk.
    text: fs.existsSync(txt) ? fs.readFileSync(txt, 'utf8') : '',
    castError
  };
}

const videoPath = String(parsed.videoPath || '').trim();
if (!videoPath) return { error: 'Give the path to a video file on this machine.' };
if (!fs.existsSync(videoPath)) {
  return { error: `No file at ${videoPath}. This runs on the machine Flowise is on, so the path has to be one it can see.` };
}

const SCRIPT = 'C:/Flowise/_shot_breakdown.js';
if (!fs.existsSync(SCRIPT)) return { error: 'The breakdown script is missing at ' + SCRIPT };

// Output goes beside the video by default, in its own folder. Frames are large
// and numerous; putting them somewhere central would mix up two films' worth.
//
// The range is in the folder name when there is one, so breaking down the mall
// sequence and then the clock tower gives you two folders rather than the second
// quietly overwriting the first - and so a folder says which part of the film it
// is of without opening it.
const tag = [parsed.start, parsed.end]
  .map((v) => String(v == null ? '' : v).trim().split(':').join(''))
  .filter(Boolean)
  .join('-');
const outDir = String(parsed.outDir || '').trim() ||
  path.join(path.dirname(videoPath), path.parse(videoPath).name + '_shots' + (tag ? '_' + tag : ''));

const args = [SCRIPT, videoPath, '--out', outDir];
if (parsed.threshold) args.push('--threshold', String(Number(parsed.threshold) || 0.3));
// A stretch of the film rather than all of it. Passed through as written -
// seconds or mm:ss or hh:mm:ss - because the script does the parsing and two
// copies of that would disagree about what "4" means.
if (String(parsed.start || '').trim()) args.push('--start', String(parsed.start).trim());
if (String(parsed.end || '').trim()) args.push('--end', String(parsed.end).trim());
if (parsed.describe === false) args.push('--describe', 'no');
if (parsed.transcribe === false) args.push('--transcribe', 'no');
if (String(parsed.model || '').trim()) args.push('--model', String(parsed.model).trim());

// No timeout. A feature-length film is thousands of frames and one vision call
// each; a wall-clock cap would be a guess about how long that ought to take, and
// killing a run at nine minutes that needed ten wastes the whole thing.
const run = await new Promise((resolve) => {
  // 'node' off the PATH, not process.execPath: `process` is not exposed inside
  // Flowise's sandbox, and reaching for it fails the whole node before ffmpeg is
  // ever called.
  //
  // shell:true is what makes 'node' resolve on Windows - and it is also why every
  // argument has to be quoted here. With a shell in the way, spawn's array is
  // flattened into one command line and cmd re-splits it on spaces, so
  // "Back to the Future - Mall.mp4" arrived as five arguments and the script
  // reported "No such file: .../My". Any real film's filename has spaces in it,
  // so this was every path that mattered.
  const quoted = args.map((a) => '"' + String(a).split('"').join('') + '"');
  const p = spawn('node', quoted, { windowsHide: true, shell: true });
  let out = '';
  let err = '';
  p.stdout.on('data', (d) => (out += d.toString()));
  p.stderr.on('data', (d) => (err += d.toString()));
  p.on('error', (e) => resolve({ code: -1, out, err: String(e && e.message) }));
  p.on('close', (code) => resolve({ code, out, err }));
});

const jsonPath = path.join(outDir, 'shots.json');
if (!fs.existsSync(jsonPath)) {
  return {
    error: 'The breakdown produced no shots.json.',
    detail: (run.err || run.out || '').slice(-800),
    exitCode: run.code
  };
}

let data;
try {
  data = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
} catch (e) {
  return { error: 'shots.json could not be read: ' + (e && e.message) };
}

// The frames are returned as paths, not as pictures. They live on disk beside the
// video and a tab showing forty of them would be moving tens of megabytes through
// a JSON response for no reason.
return {
  action: 'broken_down',
  video: videoPath,
  outDir,
  jsonPath,
  markdownPath: path.join(outDir, 'shots.md'),
  duration: data.duration,
  start: data.start,
  end: data.end,
  threshold: data.threshold,
  count: (data.shots || []).length,
  transcript: data.transcript || [],
  shots: data.shots || [],
  log: (run.out || '').split('\n').filter(Boolean).slice(-6)
};
