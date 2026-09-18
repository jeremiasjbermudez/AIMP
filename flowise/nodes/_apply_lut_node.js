// Grades a rendered clip with a colour palette, using ffmpeg's lut3d.
//
// The LUT is built from the palette's swatches with the SAME luminance-gradient
// map the browser uses on stills, so a graded frame and a graded clip agree.
// Implementing a look twice is how the preview and the render drift apart.
//
// ffmpeg rather than a ComfyUI graph: lut3d is exact, runs on CPU in seconds,
// copies the audio stream untouched, and needs no GPU queue. This is also the
// point in the pipeline where a grade belongs - after all generation and
// extension is done, so nothing downstream ever sees graded pixels and learns
// them as content.
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const insforgeUrl = $insforgeUrl;
const insforgeApiKey = $insforgeApiKey;
const comfyRoot = $comfyRoot;
const authHeaders = { Authorization: `Bearer ${insforgeApiKey}` };

let parsed;
try {
  parsed = JSON.parse(($flow.input || '').toString());
} catch (e) {
  return { error: 'Expected JSON {"clipId":"...","paletteId":"..."}' };
}
if (!parsed.clipId || !parsed.paletteId) return { error: 'Give a clipId and a paletteId.' };

const strength = Math.min(1, Math.max(0, Number(parsed.strength != null ? parsed.strength : 0.6)));

// ------------------------------------------------------------- the inputs
const clipRes = await axios.get(`${insforgeUrl}/api/database/records/minimax_clips`, {
  params: { id: `eq.${parsed.clipId}`, select: 'id,movie_id,video_path,status' },
  headers: authHeaders
});
const clip = (clipRes.data || [])[0];
if (!clip) return { error: 'That clip no longer exists.' };
if (!clip.video_path) return { error: 'That clip has no rendered video yet.' };

const palRes = await axios.get(`${insforgeUrl}/api/database/records/color_palettes`, {
  params: { id: `eq.${parsed.paletteId}`, select: 'id,name,swatches' },
  headers: authHeaders
});
const palette = (palRes.data || [])[0];
if (!palette) return { error: 'That palette no longer exists.' };
const swatches = Array.isArray(palette.swatches) ? palette.swatches : [];
if (swatches.length < 2) return { error: 'That palette has too few colours to grade with.' };

const movieRes = await axios.get(`${insforgeUrl}/api/database/records/movies`, {
  params: { id: `eq.${clip.movie_id}`, select: 'slug' },
  headers: authHeaders
});
const movie = (movieRes.data || [])[0];
if (!movie) return { error: 'Movie not found.' };

// ---------------------------------------------------------------- the LUT
function luma(r, g, b) { return 0.2126 * r + 0.7152 * g + 0.0722 * b; }

function hexToRgb(hex) {
  const h = String(hex).replace('#', '');
  return [
    parseInt(h.slice(0, 2), 16) / 255,
    parseInt(h.slice(2, 4), 16) / 255,
    parseInt(h.slice(4, 6), 16) / 255
  ];
}

const ramp = swatches.map(hexToRgb).sort((a, b) => luma(a[0], a[1], a[2]) - luma(b[0], b[1], b[2]));
if (ramp.length === 1) ramp.push(ramp[0]);

function sampleRamp(t) {
  const x = Math.max(0, Math.min(1, t)) * (ramp.length - 1);
  const i = Math.min(ramp.length - 2, Math.floor(x));
  const f = x - i;
  const a = ramp[i];
  const b = ramp[i + 1];
  return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
}

// How colourful the palette itself is. The tint below carries hue balance and
// nothing else - dividing a swatch by its own brightness removes brightness AND
// colourfulness - so a greyscale palette reduced to (1,1,1) and graded to a
// literal no-op. Saturation has to be measured and applied separately.
//
// Kept identical to gradeColor in pipeline-admin-next/src/lut.ts. If one
// changes the other must, or a graded still and a graded clip stop matching.
const PALETTE_SAT = (function () {
  let total = 0;
  for (let i = 0; i < ramp.length; i++) {
    const c = ramp[i];
    const mx = Math.max(c[0], c[1], c[2]);
    const mn = Math.min(c[0], c[1], c[2]);
    total += mx > 0.0001 ? (mx - mn) / mx : 0;
  }
  return total / ramp.length;
})();
// 0.30 is roughly an ordinary photograph's mean saturation, so a palette of
// about that colourfulness leaves the image alone. Clamped so a greyscale
// palette does not force literal monochrome, nor a bold one tip into cartoon.
const SAT_FACTOR = Math.max(0.15, Math.min(1.5, PALETTE_SAT / 0.3));

function gradeColor(r, g, b) {
  const l = luma(r, g, b);
  const t = sampleRamp(l);
  const tl = luma(t[0], t[1], t[2]);
  // A neutral-preserving TINT, not a replacement. Dividing the palette colour
  // by its own brightness leaves only colour balance, so the frame drifts
  // toward the palette while the subject keeps its own colour relationships.
  // Replacing outright is what makes an image look coloured-in.
  const tint = tl > 0.0001 ? [t[0] / tl, t[1] / tl, t[2] / tl] : [1, 1, 1];
  let gr = [Math.min(1, r * tint[0]), Math.min(1, g * tint[1]), Math.min(1, b * tint[2])];
  // Chroma scaled around the pixel's own luminance: hue stays put, only how
  // strongly it reads moves toward the palette's own colourfulness.
  const gl = luma(gr[0], gr[1], gr[2]);
  gr = [
    Math.max(0, Math.min(1, gl + (gr[0] - gl) * SAT_FACTOR)),
    Math.max(0, Math.min(1, gl + (gr[1] - gl) * SAT_FACTOR)),
    Math.max(0, Math.min(1, gl + (gr[2] - gl) * SAT_FACTOR))
  ];
  return [
    r + (gr[0] - r) * strength,
    g + (gr[1] - g) * strength,
    b + (gr[2] - b) * strength
  ];
}

const SIZE = 33;
const d = SIZE - 1;
const cube = [
  '# Generated from a pipeline colour palette',
  'TITLE "' + String(palette.name).replace(/"/g, "'") + '"',
  'LUT_3D_SIZE ' + SIZE,
  'DOMAIN_MIN 0.0 0.0 0.0',
  'DOMAIN_MAX 1.0 1.0 1.0',
  ''
];
// .cube iterates red fastest, then green, then blue.
for (let bi = 0; bi < SIZE; bi++) {
  for (let gi = 0; gi < SIZE; gi++) {
    for (let ri = 0; ri < SIZE; ri++) {
      const c = gradeColor(ri / d, gi / d, bi / d);
      cube.push(c[0].toFixed(6) + ' ' + c[1].toFixed(6) + ' ' + c[2].toFixed(6));
    }
  }
}

// ------------------------------------------------------------------ paths
function toAbs(rel) {
  const norm = String(rel).split(String.fromCharCode(92)).join('/');
  const at = norm.toLowerCase().indexOf('output/');
  return path.join(comfyRoot, at >= 0 ? norm.slice(at) : norm);
}

const srcAbs = toAbs(clip.video_path);
if (!fs.existsSync(srcAbs)) return { error: 'The clip file is missing on disk: ' + clip.video_path };

const outDir = path.join(comfyRoot, 'output', movie.slug, '_graded');
fs.mkdirSync(outDir, { recursive: true });

const stamp = Date.now();
const lutPath = path.join(outDir, 'lut_' + stamp + '.cube');
fs.writeFileSync(lutPath, cube.join('\n') + '\n');

const outName = 'graded_' + clip.id + '_' + stamp + '.mp4';
const outAbs = path.join(outDir, outName);

// ffmpeg wants forward slashes and an escaped colon in a filter argument, even
// on Windows - "C:/x" inside a filter is read as a stream specifier otherwise.
// The LUT goes in as a BARE FILENAME, with ffmpeg run from its own folder.
// A Windows absolute path cannot sit in a filter argument: the drive-letter
// colon is the filter's option separator, and escaping it is fiddly enough
// that it silently produced "Parsed_lut3d_0: Invalid argument". Taking the
// colon out of the problem beats escaping it.
const lutName = path.basename(lutPath);

const args = [
  '-y',
  '-i', srcAbs,
  '-vf', 'lut3d=file=' + lutName,
  '-c:v', 'libx264',
  '-crf', '16',
  '-preset', 'medium',
  '-pix_fmt', 'yuv420p',
  // The grade is picture only; the audio the model generated is untouched.
  '-c:a', 'copy',
  outAbs
];

const run = await new Promise((resolve) => {
  execFile('ffmpeg', args, { cwd: outDir, maxBuffer: 1024 * 1024 * 16 }, (err, stdout, stderr) => {
    // ffmpeg prints a long input dump before the failure, so a plain tail
    // slice can cut the error off - which is exactly what hid this one.
    // Pull the lines that name a problem first; the tail is the fallback.
    const text = String(stderr || '');
    const blame = text.split(String.fromCharCode(10)).filter(function (l) {
      return /error|invalid|no such|failed|unable/i.test(l);
    });
    resolve({ err: err, stderr: (blame.length ? blame.join(' | ') : text).slice(-1200) });
  });
});

if (run.err || !fs.existsSync(outAbs)) {
  return {
    action: 'error',
    reason: 'ffmpeg could not grade the clip: ' + (run.stderr || (run.err && run.err.message) || 'unknown'),
    lut: 'output/' + movie.slug + '/_graded/' + path.basename(lutPath)
  };
}

const size = fs.statSync(outAbs).size;
return {
  action: 'complete',
  clipId: clip.id,
  palette: palette.name,
  strength: strength,
  videoPath: 'output/' + movie.slug + '/_graded/' + outName,
  lutPath: 'output/' + movie.slug + '/_graded/' + path.basename(lutPath),
  bytes: size
};
