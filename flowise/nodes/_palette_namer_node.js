// Names a colour palette and writes the grading note for it.
//
// The swatches arrive already measured - the app quantises the image's own
// pixels in the browser, so they are exact. This node is deliberately NOT asked
// for hex values: a vision model asked to read colours off a picture returns
// plausible-looking numbers that are quietly wrong, which is worse than no
// answer because they look right.
//
// What it is good at is the half that steers a render. "Teal shadows, warm skin,
// crushed blacks" moves an image generator; a list of six hex codes does not.
const axios = require('axios');
const insforgeUrl = $insforgeUrl;
const insforgeApiKey = $insforgeApiKey;
const comfyUrl = $comfyUrl;
// @include llm
// ---------------------------------------------------------------------------
const authHeaders = { Authorization: `Bearer ${insforgeApiKey}` };

let parsed;
try {
  parsed = JSON.parse(($flow.input || '').toString());
} catch (e) {
  return { error: 'Expected JSON {"imagePath":"output/...","swatches":["#..."]}' };
}

const swatches = Array.isArray(parsed.swatches) ? parsed.swatches.filter(Boolean) : [];
if (!swatches.length) return { error: 'No swatches were given.' };

function toViewPath(raw) {
  const norm = String(raw).split(String.fromCharCode(92)).join('/');
  const m = /(?:^|\/)(output|input|temp)\/(.+)$/i.exec(norm);
  return m ? m[1].toLowerCase() + '/' + m[2] : norm.replace(/^\//, '');
}

// Fetch the picture so the model can actually look at it.
let bytes = null;
try {
  if (parsed.imagePath) {
    const rel = toViewPath(parsed.imagePath);
    const at = rel.indexOf('/');
    const type = rel.slice(0, at);
    const rest = rel.slice(at + 1);
    const slash = rest.lastIndexOf('/');
    const res = await axios.get(`${comfyUrl}/view`, {
      params: {
        filename: slash >= 0 ? rest.slice(slash + 1) : rest,
        subfolder: slash >= 0 ? rest.slice(0, slash) : '',
        type: type
      },
      responseType: 'arraybuffer'
    });
    if (res.status === 200 && res.data && res.data.byteLength) bytes = Buffer.from(res.data);
  } else if (parsed.storageKey && parsed.movieId) {
    const mv = await axios.get(`${insforgeUrl}/api/database/records/movies`, {
      params: { id: `eq.${parsed.movieId}`, select: 'bucket_name' },
      headers: authHeaders
    });
    const bucket = (mv.data || [])[0] && mv.data[0].bucket_name;
    if (bucket) {
      // Fully encoded: an uploaded filename can contain %, [ ] and spaces.
      const res = await axios.get(
        `${insforgeUrl}/api/storage/buckets/${bucket}/objects/` + encodeURIComponent(parsed.storageKey),
        { headers: authHeaders, responseType: 'arraybuffer' }
      );
      const buf = Buffer.from(res.data);
      // A failed download comes back as a small JSON body with a 200.
      if (!(buf.length < 512 && /^\s*[{[]/.test(buf.toString('utf8').slice(0, 40)))) bytes = buf;
    }
  }
} catch (e) {
  // Not fatal - the swatches alone are enough to name something reasonable.
  bytes = null;
}

const INSTRUCTION =
  'You are a colourist naming a look.\n\n' +
  'These swatches were measured from the image, darkest to lightest:\n' +
  swatches.join(', ') + '\n\n' +
  (bytes ? 'The image itself is attached. Describe the grade you can see in it.\n\n' : '') +
  'Return ONLY JSON, no prose and no code fence:\n' +
  '{"name": "...", "description": "..."}\n\n' +
  'Rules:\n' +
  '- name: two or three words, evocative and specific, the way a film LUT is named. ' +
  '"Sodium Night", "Bleach Bypass", "Kodak Warm". Not "Palette 1", not a list of colours.\n' +
  '- description: two or three sentences a colourist would recognise. Say where the shadows sit, ' +
  'where the highlights sit, how saturated the mid-tones are, and what the light is doing. ' +
  'Describe the GRADE, not the subject of the photograph.\n' +
  '- Do not restate the hex values. Do not invent any new ones.';

let reply;
try {
  const message = { role: 'user', content: INSTRUCTION };
  if (bytes) message.images = [bytes.toString('base64')];
  const res = await llmChat(
    { model: ollamaModel, stream: false, think: false, options: { temperature: 0.7 }, messages: [message] },
    { timeout: 300000 }
  );
  reply = ((res.data && res.data.message && res.data.message.content) || '').trim();
} catch (e) {
  const detail = e.response ? JSON.stringify(e.response.data).slice(0, 300) : e.message;
  return { error: 'The vision model did not answer: ' + detail };
}

reply = reply.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
reply = reply.replace(/^```[a-z]*\s*/i, '').replace(/```\s*$/i, '').trim();

let out;
try {
  const a = reply.indexOf('{');
  const b = reply.lastIndexOf('}');
  out = JSON.parse(a >= 0 ? reply.slice(a, b + 1) : reply);
} catch (e) {
  return { error: 'The model did not return usable JSON.', raw: reply.slice(0, 400) };
}

const name = String(out.name || '').trim().slice(0, 60);
const description = String(out.description || '').trim().slice(0, 800);
if (!name) return { error: 'The model returned no name.', raw: reply.slice(0, 300) };

return {
  action: 'complete',
  name: name,
  description: description,
  sawImage: !!bytes,
  swatches: swatches
};
