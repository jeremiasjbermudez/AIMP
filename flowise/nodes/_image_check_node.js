// 44-Image-Check: does this picture show what was asked for?
//
// A render either matches the prompt or it does not, and the only way to know
// has been to look. That is fine for one picture and useless across forty, which
// is how a plan ends up half full of frames nobody checked.
//
// So the same vision model that reads frames for the continuity pass is pointed
// at one picture and one prompt, and asked the narrow version of the question.
//
// WHAT IT IS NOT: a judge of quality. It cannot tell you a composition is dull
// or a face is uncanny, and asking it to would produce confident nonsense. It
// answers one thing - is what the prompt asked for actually in the picture - and
// the caller decides what to do about it.
//
// Input:  {"imagePath":"output/...","prompt":"...","strict":false}
// Output: {"action":"checked","ok":true,"why":"","missing":[...]}
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const insforgeUrl = $insforgeUrl;
const insforgeApiKey = $insforgeApiKey;
const comfyUrl = $comfyUrl;
// @include llm
// ---------------------------------------------------------------------------
let parsed;
try {
  parsed = JSON.parse(($flow.input || '').toString());
} catch (e) {
  return { error: 'Expected JSON {"imagePath":"output/...","prompt":"..."}' };
}
const imagePath = String(parsed.imagePath || '').trim();
const prompt = String(parsed.prompt || '').trim();
if (!imagePath) return { error: 'Give the path of the picture to check.' };
if (!prompt) return { error: 'Give the prompt it was rendered from.' };

// Read from ComfyUI's own folder rather than over HTTP: the file is on this
// machine and a round trip through /view only adds a way to fail.
const COMFY_ROOT = String($comfyRoot || 'C:/ComfyUI2').replace(/[\\/]+$/, '');
let bytes;
try {
  const rel = String(imagePath).split('\\').join('/');
  bytes = fs.readFileSync(path.join(COMFY_ROOT, rel));
} catch (e) {
  return { error: 'Could not read that picture: ' + (e && e.message ? e.message : String(e)) };
}

// The prompt carries a style prefix, a camera line, a setting and reference
// notes. Asking "does the picture match all of this" invites a no on the parts a
// picture cannot show. What is being checked is the SUBJECT: who and what is in
// frame and what they are doing.
const q = [
  'You are checking whether a rendered picture shows what was asked for.',
  '',
  'This is what was asked for:',
  prompt.slice(0, 1800),
  '',
  'Rules for your answer:',
  '- Judge only what the prompt says should be IN THE PICTURE: the people, the objects, what they are',
  '  doing, and where they are. Ignore anything about camera, lens, lighting style, film stock, mood or',
  '  rendering style - a still cannot be wrong about those.',
  '- ok is false when something the prompt asks for is MISSING, when there is an obvious extra person or',
  '  object that was never asked for, or when someone is duplicated.',
  '- ok is false when a described thing is plainly the WRONG THING - a different kind of object, a',
  '  different colour of clothing, an adult where a child was asked for.',
  '- ok is TRUE when the picture shows what was asked for, even if details are small, partly hidden, or',
  '  less detailed than the words. A description is always more specific than a picture can be.',
  '- If you are unsure, answer ok: true. A false alarm costs a re-render of a picture that was fine.',
  '',
  'Return ONLY JSON: {"ok":true|false,"why":"one short sentence, only if ok is false","missing":["..."]}'
].join('\n');

let out;
try {
  const res = await llmChat(
    {
      model: ollamaModel,
      stream: false,
      think: false,
      // A reading, not an opinion.
      options: { temperature: 0.1 },
      format: 'json',
      messages: [{ role: 'user', content: q, images: [bytes.toString('base64')] }]
    },
    { timeout: 300000 }
  );
  out = JSON.parse(((res.data && res.data.message && res.data.message.content) || '').trim());
} catch (e) {
  // A check that cannot run must not be read as a failed picture: the caller
  // would re-render something that was never judged.
  return {
    error: 'The check could not run: ' + (e && e.message ? e.message : String(e)),
    ok: null
  };
}

return {
  action: 'checked',
  ok: out.ok !== false,
  why: String(out.why || '').trim(),
  missing: Array.isArray(out.missing) ? out.missing.filter(Boolean).map(String) : []
};
