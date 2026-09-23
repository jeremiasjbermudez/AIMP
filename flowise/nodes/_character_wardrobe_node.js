// 40-Character-Wardrobe: a character's reference sheet, wearing a costume.
//
// Why this is its own step rather than something the shot render does.
//
// A shot render has four reference slots. Handing it the person, the garment,
// a plate and two other faces and asking it to combine them is where FLUX and
// Qwen start inventing - the garment drifts, or it lands on the wrong person.
// And it is asked to do that work again on every single shot.
//
// So the costume goes on ONCE, here, against the character's own reference
// sheet. What comes back is another reference sheet for that character, tagged
// with the costume. A shot where they wear it then needs ONE picture for that
// person instead of two, and the costume cannot drift because it is part of the
// likeness rather than something reconciled per shot.
//
// It renders a SHEET, not a single picture, because that is what it replaces: a
// character's reference is a multi-view sheet, and one front-on image would be a
// weaker reference than the thing it stands in for.
//
// Input:  {"movieId":"...","characterId":"...","propId":"..."}
// Output: {"action":"dressed","imagePath":"output/...","character":"a character","costume":"Red Bubble Vest"}
const axios = require('axios');
const insforgeUrl = $insforgeUrl;
const insforgeApiKey = $insforgeApiKey;
const comfyUrl = $comfyUrl;
const authHeaders = { Authorization: `Bearer ${insforgeApiKey}` };
const jsonHeaders = { ...authHeaders, 'Content-Type': 'application/json', Prefer: 'return=representation' };

let parsed;
try {
  parsed = JSON.parse(($flow.input || '').toString());
} catch (e) {
  return { error: 'Expected JSON {"movieId":"...","characterId":"...","propId":"..."}' };
}
if (!parsed.movieId || !parsed.characterId || !parsed.propId) {
  return { error: 'Give a movieId, a characterId and a propId.' };
}

const clean0 = (t) => String(t || '').replace(/\s+/g, ' ').trim().replace(/[.\s]+$/, '');

async function records(table, params) {
  const r = await axios.get(`${insforgeUrl}/api/database/records/${table}`, { params, headers: authHeaders });
  return r.data || [];
}

const character = (
  await records('characters', { id: `eq.${parsed.characterId}`, select: 'id,name,visual_anchor,render_style' })
)[0];
if (!character) return { error: 'No such character.' };

const costume = (
  await records('movie_props', { id: `eq.${parsed.propId}`, select: 'id,name,kind,description,image_path' })
)[0];
if (!costume) return { error: 'No such costume.' };
if (!costume.image_path) {
  return { error: `${costume.name} has no sheet, so there is nothing to put on. Render one in Props & Wardrobe first.` };
}

// The character's own sheet is the likeness this has to preserve. A qa_front is
// accepted as a fallback - it is a weaker reference, but a face from the front
// is better than nothing, and some characters only ever got that far.
const images = await records('character_images', {
  character_id: `eq.${character.id}`,
  select: 'id,kind,image_path,version,wardrobe_prop_id',
  order: 'version.asc'
});
const plain = images.filter((i) => i.image_path && !i.wardrobe_prop_id);
const base = plain.filter((i) => i.kind === 'sheet').slice(-1)[0] || plain.filter((i) => i.kind === 'qa_front').slice(-1)[0];
if (!base) {
  return {
    error: `${character.name} has no reference sheet yet, so there is nothing to dress. Generate their references first.`
  };
}

// The film's look, so a dressed sheet matches the cast it sits beside.
const STYLES = {
  anime: 'Anime screenshot, 2D cel-shaded anime, clean line art, vibrant colors.',
  cartoon: '2D cartoon still, bold outlines, flat vivid colors.',
  animated: '3D animated film still, stylized, soft cinematic lighting.',
  photographic: 'Cinematic photograph.'
};
const style = STYLES[character.render_style] || STYLES.photographic;

// The garment is NAMED and DESCRIBED, not pointed at.
//
// "Wearing the garment from the second image" asks the model to work out what
// the garment is, and it guessed: a reference sheet of a red puffer vest came
// back as a plain red shirt. The description that produced that sheet is sitting
// in movie_props, so it is stated here as well. Words and picture together, the
// same way every other reference in this pipeline works - the picture holds the
// detail, the words stop it being read as something else entirely.
const garment = clean0(costume.description) || costume.name;
const prompt = [
  style,
  `Character reference sheet of ${character.name}, wearing ${costume.name}.`,
  `The ${costume.name} is: ${garment}.`,
  'The second image shows that exact garment from several angles - match it: same colour, same cut, same fastenings, same details, same proportions.',
  // Both halves are stated as absolutes because this is the picture every later
  // render trusts: a likeness that drifts here drifts everywhere.
  'Keep the face, hair, build and proportions EXACTLY as the first image - same person, unmistakably.',
  // "Keep the first image exactly" was taken to include the clothes in it, so
  // the garment arrived on top of the shirt the character was already wearing.
  // A change of clothes is a change, not a layer.
  'REPLACE their clothing entirely. They are not wearing what they wore in the first image - that outfit is gone.',
  'Anything the garment does not cover is plain and unremarkable, so nothing competes with it.',
  'Three views of the same figure on one sheet: a large full-length front view, with a back view and a side view beside it.',
  'Plain white background, even studio lighting, no shadow, the whole figure visible and uncropped in every view.',
  'No other people, no props, no text, no logo, no watermark.'
].join(' ');

// 1344x768 so the sheet can be used as a MiniMax reference without being
// letterboxed on the way in - the same canvas every other sheet uses.
const WIDTH = 1344;
const HEIGHT = 768;

const wf = {
  prompt,
  references: [
    { path: base.image_path, label: 'the person' },
    { path: costume.image_path, label: 'the garment' }
  ],
  width: WIDTH,
  height: HEIGHT,
  steps: 8
};

// The render goes through 26-Image-Edit rather than a graph of its own: it
// already stages reference images into ComfyUI's input folder, handles Klein's
// reference wiring, and follows the job to completion. Rebuilding that here
// would be a second copy of it to keep in step.
// By name, resolved to this install's id when the flow is registered.
const editId = parsed.imageEditFlowId || '{{flow:26-Image-Edit}}';
let out;
try {
  const r = await axios.post(
    `${String($flowiseUrl).replace(/\/$/, '')}/api/v1/prediction/${editId}`,
    { question: JSON.stringify({ movieId: parsed.movieId, ...wf }) },
    { timeout: 1800000, validateStatus: () => true, headers: { Authorization: `Bearer ${$flowiseApiKey}` } }
  );
  out = JSON.parse(r.data.text || '{}');
} catch (e) {
  return { error: 'The image render could not be reached: ' + (e && e.message ? e.message : String(e)) };
}
if (!out || !out.outputPath) {
  return { error: 'The sheet did not render.', detail: JSON.stringify(out).slice(0, 400) };
}

// Stored as a reference image of the CHARACTER, tagged with the costume - so it
// is found the same way every other reference is, and a costume deleted takes
// its dressed sheets with it.
// (character_id, kind, version) is unique, and `version` defaults to 1 - so the
// number cannot be guessed once and hoped for. Reading the highest and adding
// one is a read-then-write race, and it was also counting across kinds, so a
// 'sheet' could be handed a number a 'dressed' row had already taken. Try, and
// on a collision take the next number and try again: the database decides who
// wins rather than a count taken beforehand.
let version = Math.max(0, ...images.filter((i) => i.kind === 'sheet').map((i) => Number(i.version) || 0)) + 1;
let ins = null;
for (let attempt = 0; attempt < 25; attempt++) {
  ins = await axios.post(
    `${insforgeUrl}/api/database/records/character_images`,
    [
      {
        character_id: character.id,
        kind: 'sheet',
        image_path: out.outputPath,
        wardrobe_prop_id: costume.id,
        version,
        source: 'wardrobe'
      }
    ],
    { headers: jsonHeaders, validateStatus: () => true }
  );
  if (ins.status >= 200 && ins.status < 300) break;
  const dup = ins.data && (ins.data.code === '23505' || /duplicate key/i.test(JSON.stringify(ins.data)));
  if (!dup) break;
  version += 1;
}
if (!ins || ins.status < 200 || ins.status >= 300) {
  return {
    error: `The sheet rendered but was not recorded (HTTP ${ins ? ins.status : '-'}).`,
    imagePath: out.outputPath,
    detail: JSON.stringify(ins && ins.data).slice(0, 300)
  };
}

return {
  action: 'dressed',
  character: character.name,
  costume: costume.name,
  imagePath: out.outputPath,
  version,
  basedOn: base.kind,
  note:
    base.kind === 'sheet'
      ? 'Built from their reference sheet. Shots where they wear this now use one picture for them instead of two.'
      : 'Built from a front-on QA shot, which is all this character has - generate a full reference sheet for a stronger likeness.'
};
