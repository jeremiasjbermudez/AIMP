// 39-Director: plan a movie's shot list from its beats and characters.
//
// Rules: C:\Flowise\DIRECTOR.md section 5. Change a rule there first.
//
// Input: {"movieId": "...", "planId": "...", "targetSeconds": 120, "mode": "check" | "plan"}
//   check (default) - dry run: report what a plan would be built from; writes nothing.
//   plan            - the LLM drafts the shot list, this code enforces the rules
//                     and writes director_shots for the plan, then stops.
//
// The split is deliberate. The model decides what is creative - shot type, who
// is on screen, what happens, which line a shot carries, what it sounds like,
// each scene's look. Everything with an exact format is computed here so it
// cannot come out wrong: lengths on MiniMax's grid, line timestamps, the
// motion-prompt wording, the style prefix, and every check in 5.7.
const axios = require('axios');

const insforgeUrl = $insforgeUrl;
const insforgeApiKey = $insforgeApiKey;
// The flow has carried this variable all along (it comes across from the Image
// Edit clone), but nothing bound it until render mode needed to talk to ComfyUI.
const comfyUrl = $comfyUrl;
// @include llm
// ---------------------------------------------------------------------------
const authHeaders = { Authorization: `Bearer ${insforgeApiKey}` };
const jsonHeaders = { ...authHeaders, 'Content-Type': 'application/json', Prefer: 'return=representation' };

let parsed;
try {
  parsed = JSON.parse(($flow.input || '').toString());
} catch (e) {
  return { error: 'Expected JSON {"movieId":"...","planId":"...","targetSeconds":120,"mode":"plan"}' };
}
if (!parsed.movieId) return { error: 'Missing movieId.' };
// check = dry run, plan = draft the shot list, chainplan = translate an existing
// shot list into a MiniMax H3 Context Loop plan (7b). Anything else is a dry run.
const mode = ['plan', 'chainplan', 'render', 'assemble', 'review', 'insert', 'rebind'].includes(parsed.mode) ? parsed.mode : 'check';
const targetSeconds = Math.max(15, Math.min(900, Number(parsed.targetSeconds) || 120));

async function records(table, params) {
  const r = await axios.get(`${insforgeUrl}/api/database/records/${table}`, { params, headers: authHeaders });
  return r.data || [];
}

// Hoisted above the mode branches: rebind needs the same anchor the planner
// uses, and a const declared inside plan mode is invisible from up here - the
// error is a ReferenceError at run time, not at deploy.
const clean = (t) => String(t || '').replace(/\s+/g, ' ').trim().replace(/[.\s]+$/, '');

const anchorText = (n) => (characters.find((c) => String(c.name).toUpperCase() === n) || {}).visual_anchor || '';

// The few features that actually identify someone on screen: the hair, then
// what they are wearing. The anchors also carry eyes, earrings and trousers,
// which cost words without helping - the hand-made prompt that worked used
// "spiky ash-blond hair, a black tank top and bandaged arms" and nothing else.
const WEARS = /(shirt|tank|hoodie|jacket|coat|dress|skirt|trousers|shorts|headband|clip|patch|bandag|cloak|uniform|scarf|glasses|hat|cap)/i;

const anchorOf = (n, wornLook) => {
  const feats = clean(anchorText(n))
    .replace(/^(?:an?|the)\b[^,]*?\bwith\s+/i, '')
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
  const hair = feats.filter((f) => /hair/i.test(f)).slice(0, 1);
  // A costume REPLACES the clothes in the description rather than joining them.
  //
  // a character's own description spends a sentence on a denim shirt over a white
  // t-shirt. Put a vest on him and the prompt used to say both, so the render
  // was asked for a vest AND a denim shirt and produced whichever it preferred.
  // A change of clothes is a change, not an addition.
  //
  // Not one already taken as the hair: "long blue-grey hair and a small white
  // hair clip" matches "clip" too, and would otherwise be listed twice.
  // Only a PERSON has hair and clothes.
  //
  // The rule below reduces a description to hair plus garments, which is right
  // for a person and wrong for everything else. One cast member's description
  // read "a small fluffy white dog with a distinctive, somewhat ragged coat":
  // nothing matched as hair, "coat" matched as a garment, and the whole
  // description collapsed to the coat - so what the character actually WAS never
  // reached the prompt. Nothing in the data was wrong; the rule simply did not
  // apply and had no way of knowing.
  //
  // Read from `kind` rather than inferred, so anything that is not a person keeps
  // its description as written: what it IS is the part that identifies it, and
  // there is no outfit to swap.
  const beast = (CHAR_KIND[String(n).toUpperCase()] || 'person') !== 'person';
  const worn = wornLook
    ? [clean(wornLook)]
    : beast
      ? []
      : feats.filter((f) => WEARS.test(f) && !hair.includes(f)).slice(0, 2);
  const picked = beast ? feats.slice(0, 3) : hair.length || worn.length ? [...hair, ...worn] : feats.slice(0, 3);
  // Whole features only. Slicing by word count cut PINKY's look off at "a black
  // hoodie with", and the frame came back with a plain black hoodie and no pink
  // lining - the truncation deleted the one detail that made it his.
  const out = [];
  let words = 0;
  for (const f of picked) {
    const w = f.split(/\s+/).length;
    // A costume is never dropped by the cap. The cap exists to stop a rambling
    // character description filling the prompt, and 24 words is generous for
    // "hair and two garments" - but a whole outfit is one long clause, so it
    // blew the budget and was silently cut, leaving "a character, with sandy-brown
    // hair and bright," and no clothes at all. The costume IS the point of the
    // sentence when there is one.
    const mustKeep = wornLook && f === clean(wornLook);
    if (!mustKeep && out.length && words + w > 24) break;
    out.push(f);
    words += w;
  }
  return out.join(', ').replace(/[.,;]+$/, '');
};


// A model asked for an optional field answers with the WORD, not the value:
// "null", "none", "n/a", "-". Stored as-is those read back as real content
// and get pasted into prompts.
const nothing = (t) => !String(t == null ? '' : t).trim() ||
  /^(?:null|none|n\/a|na|nil|undefined|-|--|not applicable|nothing)$/i.test(String(t).trim());

const movie = (await records('movies', { id: `eq.${parsed.movieId}`, select: 'id,title,slug' }))[0];
if (!movie) return { error: 'Movie not found.' };

const beats = await records('beats', {
  movie_id: `eq.${movie.id}`,
  select: 'id,beat_code,scene_number,scene_heading,location,time_of_day,summary,action_text,dialogue,characters',
  order: 'sequence_index.asc'
});
const scenes = await records('scenes', {
  movie_id: `eq.${movie.id}`,
  select: 'scene_number,location_name,location_description,time_of_day,atmosphere,sound_ambience,key_light,screen_direction,staging',
  order: 'scene_number.asc'
});
const characters = await records('characters', { movie_id: `eq.${movie.id}`, select: 'name,visual_anchor,render_style,kind,gender' });

// What each character IS, and the word for them, read once here.
//
// Next to the cast it is built from, NOT beside the function that uses it:
// anchorOf() is called from the rebind path long before that point in the file,
// and a const declared further down is in its temporal dead zone until then -
// a ReferenceError that only fires on the path nobody tested.
const CHAR_KIND = {};
const CHAR_GENDER = {};
for (const c of characters) {
  const key = String(c.name).toUpperCase();
  CHAR_KIND[key] = String(c.kind || 'person').toLowerCase();
  CHAR_GENDER[key] = String(c.gender || '').toLowerCase();
}
// Props and wardrobe (Props & Wardrobe tab). These are authoritative: where the
// model invents a "subjects" entry for the same thing, the table wins, because
// the table is what the operator approved and what the sheet was rendered from.
const propRows = await records('movie_props', {
  movie_id: `eq.${movie.id}`,
  select: 'id,name,kind,description,scale_note,image_path,aliases,worn_by'
});
// name -> the words repeated wherever it appears. Scale is included because a
// description alone never fixes size: the wish star came out a different size
// in every shot until it was stated.
// Each prop becomes { look, names[] }: the words to paste in, and every word
// the script might call it by. A prop is almost never called one thing - in one
// 23-shot draft the same object was "a wish star crystal", "the crystal", "the
// cracked crystal" and "wish star", so matching the canonical name alone bound
// almost nothing. Names are sorted longest first so "wish star crystal" wins
// over "crystal" and the fuller phrase is the one that gets described.
const propList = [];
for (const p of propRows) {
  const canonical = String(p.name || '').trim();
  if (!canonical) continue;
  const bits = [String(p.description || '').trim(), String(p.scale_note || '').trim()].filter(Boolean);
  if (!bits.length) continue;
  const extra = Array.isArray(p.aliases) ? p.aliases : [];
  const names = [canonical, ...extra]
    .map((n) => String(n || '').trim().toLowerCase())
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);
  propList.push({
    id: p.id,
    kind: p.kind || 'prop',
    // For a costume: who wears it. A costume is not named in the text the way a
    // prop is - the shot says BROWN, not "the radiation suit" - so it binds to
    // the person instead. Measured on one film: 19 shots had BROWN in them and
    // 1 named the suit.
    wornBy: p.worn_by ? String(p.worn_by).toUpperCase() : null,
    canonical,
    look: bits.join(', '),
    names: [...new Set(names)],
    image_path: p.image_path || null,
    // A stable tag for the Context Loop path: "the wish star" -> @the_wish_star.
    tag: canonical.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')
  });
}
// Every word any prop answers to, for the subjects guard below. Leading "the"
// is dropped on both sides so "the a vehicle" and "a vehicle" are one thing.
const subjectKey = (v) => String(v || '').trim().toLowerCase().replace(/^the\s+/, '');
const propNameSet = new Set();
for (const p of propList) for (const n of p.names) propNameSet.add(subjectKey(n));

const sceneNumbers = new Set(beats.map((b) => b.scene_number).filter((n) => n != null));
const sceneList = [...sceneNumbers].sort((a, b) => a - b);

// The dry run and the plan-mode guards now sit below the coverage arithmetic
// (5.9): both report the script's own length, which has to be worked out first.

// ---------------------------------------------------------------- style
// From the characters' render_style (5.6). The prefixes are the ones Starfall
// and the the project remake were made with.
const styleKey = (() => {
  const s = characters.map((c) => c.render_style).filter(Boolean);
  if (s.includes('anime')) return 'anime';
  if (s.includes('cartoon')) return 'cartoon';
  if (s.includes('animated')) return 'animated';
  return 'photographic';
})();
const STYLE = {
  anime: { frame: 'Anime screenshot, 2D cel-shaded anime, clean line art, vibrant colors.', motion: '2D-animated anime style.' },
  cartoon: { frame: '2D cartoon still, bold outlines, flat vivid colors.', motion: '2D cartoon animation.' },
  animated: { frame: '3D animated film still, stylized characters, soft cinematic lighting.', motion: '3D animated film style.' },
  photographic: { frame: 'Cinematic photograph.', motion: 'Cinematic, live-action.' }
}[styleKey];

// ------------------------------------------------ lines, cast, scenes
// Every dialogue line gets an id; the model refers to lines by id only, so the
// words that reach the prompt are always the screenplay's, verbatim.
const charNames = new Set(characters.map((c) => String(c.name).toUpperCase()));
const lines = [];
for (const b of beats) {
  const d = Array.isArray(b.dialogue) ? b.dialogue : [];
  d.forEach((x, i) => {
    const text = String(x.line || x.text || '').trim();
    const who = String(x.character || '').trim().toUpperCase();
    if (text && who) lines.push({ id: `${b.beat_code}#${i + 1}`, beat: b.beat_code, scene: b.scene_number, character: who, text });
  });
}
const lineById = Object.fromEntries(lines.map((l) => [l.id, l]));
const sceneByNum = Object.fromEntries(scenes.map((s) => [s.scene_number, s]));
const beatByCode = Object.fromEntries(beats.map((b) => [b.beat_code, b]));

// Who is physically in each scene - the beat's on-screen characters plus
// every speaker. A reaction shot needs someone other than the speaker (5.3).
const present = {};
for (const b of beats) {
  const set = present[b.scene_number] || (present[b.scene_number] = new Set());
  (Array.isArray(b.characters) ? b.characters : []).forEach((c) => {
    const n = String((c && typeof c === 'object' ? c.name || c.character : c) || '').toUpperCase().trim();
    const pr = c && typeof c === 'object' ? c.presence : null;
    if (n && charNames.has(n) && pr !== 'voice_only' && pr !== 'off_screen') set.add(n);
  });
  (Array.isArray(b.dialogue) ? b.dialogue : []).forEach((d) => {
    const n = String(d.character || '').toUpperCase().trim();
    if (charNames.has(n)) set.add(n);
  });
}
const others = (scene, speaker) => [...(present[scene] || [])].filter((n) => n !== speaker);

// 5.5 - who the text says is on screen. The model writes people into the frame
// without listing them ("the five sit along the railing", characters: []), and
// they then vanish: no references, and nobody described in the frame prompt -
// Starfall's closing shot came out as an empty rooftop. Names are matched in
// upper case only, as the model is told to write them, so a "red glow" is not
// read as RED.
const GROUP_WORDS = /\b(?:the (?:five|four|three|group|others|friends|rest|two)|everyone|all of them|the whole group)\b/i;
// Matched in UPPER or Title case, never lower case - so "a red glow" and "a pink
// lining" are not read as RED and PINKY. Matching upper case ALONE missed every
// name the model actually writes ("Chibi", "Blondi"), so this rule never fired
// and those people reached the renderer as a bare name with no reference. These
// names are colour words: "Blondi" with no image is just a blond stranger.
const nameRe = (n) => new RegExp(`\\b(?:${n}|${n[0]}${n.slice(1).toLowerCase()})\\b`, 'g');
const namesIn = (t) => [...charNames].filter((n) => nameRe(n).test(String(t || '')));
// Someone who cannot carry a reference is not named. "another person" has no
// colour in it; a run of them collapses so the sentence still reads.
const anonymise = (t, who) => {
  let out = String(t || '');
  for (const n of who) out = out.replace(nameRe(n), 'another person');
  out = out.replace(/another person(?:(?:,\s*|,?\s+and\s+)another person)+/g, 'other people');
  return out.replace(/\s{2,}/g, ' ').trim();
};
// "The five watch in awe" with four listed - an explicit count in the text is
// checked against the cast. Only a number counts: a plain "the group" is left
// alone, because a medium of one character can say "he points to the group".
const COUNTS = { two: 2, three: 3, four: 4, five: 5 };
const saidCount = (t) => {
  const m = String(t || '').match(/\b(?:the|all|both|these|those)\s+(two|three|four|five)\b/i);
  return m ? COUNTS[m[1].toLowerCase()] : 0;
};

// 5.3 - a scene opens with an establishing shot only when its location or
// time of day differs from the scene before (the first scene always does).
const where = (n) => {
  const s = sceneByNum[n] || {};
  const b0 = beats.find((b) => b.scene_number === n) || {};
  return { location: s.location_name || b0.location || 'the location', time: s.time_of_day || b0.time_of_day || '' };
};
const needsEstablishing = new Set();
{
  let prev = null;
  for (const n of sceneList) {
    const w = where(n);
    const key = `${w.location}|${w.time}`.toLowerCase();
    if (key !== prev) needsEstablishing.add(n);
    prev = key;
  }
}

// ------------------------------------------------------- length rules
const GRID = (f) => {
  const n = Math.max(124, Math.min(362, Math.ceil(f)));
  return Math.min(362, n + ((5 - (n % 17) + 17) % 17));
};
// 5.9 - a silent shot is MiniMax's floor, full stop. The model no longer picks
// a length: given a 5-7 s range and a runtime to reach, it put every silent
// shot in a 240 s draft at the 7.3 s cap and none at the floor. Section 5.8
// will let the cut use only part of a clip, which is what really shortens them.
const SILENT = 124;
const lineTiming = (text) => {
  const words = String(text).split(/\s+/).filter(Boolean).length;
  const start = 0.8;
  const end = start + Math.max(1.2, words / 2.5);
  return { start, seconds: end + 1.0 };
};
const frameCount = (s) => {
  const l = s.line && lineById[s.line];
  return l ? GRID(lineTiming(l.text).seconds * 24) : SILENT;
};

// ------------------------------------------------- 5.9 what the script is
// The film's length is a RESULT of covering the script, not a target to fill.
// Every line is a shot; every line with someone else present gets a reaction;
// every scene that changes place or time gets an establishing shot; each beat
// pays for at most one more shot for action, an insert or a cutaway. Whatever
// that sums to IS the film. Nothing is stretched or invented to reach a number.
const dialogueFrames = lines.reduce((n, l) => n + GRID(lineTiming(l.text).seconds * 24), 0);
const requiredReactions = lines.filter((l) => others(l.scene, l.character).length > 0).length;
const requiredEstablishing = needsEstablishing.size;
const actionShots = beats.length; // one per beat at most, so a thin script cannot be inflated
const requiredMasters = sceneList.filter((n) => (present[n] || new Set()).size > 1).length;
const coverageShots = lines.length + requiredReactions + requiredEstablishing + actionShots + requiredMasters;
const naturalFrames = dialogueFrames + (requiredReactions + requiredEstablishing + actionShots + requiredMasters) * SILENT;
const naturalSeconds = naturalFrames / 24;
const clock = (s) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`;
// The runtime asked for is advice, never a quota. The answer to "make it
// longer" is more script (5.9) - so say that instead of padding.
const advice =
  naturalSeconds < targetSeconds * 0.9
    ? `This script is about ${clock(naturalSeconds)} of film, not ${clock(targetSeconds)}. To make it longer, write more script - the Director will not pad it out.`
    : naturalSeconds > targetSeconds * 1.1
      ? `This script runs about ${clock(naturalSeconds)}, longer than the ${clock(targetSeconds)} asked for. Nothing was cut - shorten the script if you want a shorter film.`
      : null;

// What each person is wearing in the shot being composed. Set by whoever is
// about to compose one, and read by the binders: they are declarations, not
// closures, so they cannot see a loop variable belonging to their caller.
let shotCostume = {};

/**
 * What the people in one shot are wearing. THE one answer to that question.
 *
 * There were three copies of this rule and they disagreed, which cost most of a
 * day. The prompt rewriter dressed someone for the whole scene; the tab only
 * recognised the shots that had been ticked, so it sent the plain reference sheet
 * against a prompt describing a costume; and the review pass knew nothing about
 * costumes at all, so it checked everyone against their DEFAULT description,
 * failed them for wearing what we had deliberately put them in, and wrote a
 * correction saying "a character is: ...denim shirt... Match it exactly" - which would
 * have undressed all of them on the next repair pass.
 *
 * The order, most specific first:
 *   1. the shot's own pairs   - ticked here, for this shot
 *   2. this scene's choice    - ticked on another shot of the same scene, because
 *                               a costume holds for the scene it is assigned at
 *   3. the screenplay         - what the beat says they are wearing
 *   4. the costume's wearer   - and only when they own exactly one, since nothing
 *                               can choose between two
 *
 * An EMPTY pair list is a deliberate "nobody is wearing anything", and stays one.
 */
function costumesFor(r, allRows) {
  const here = (Array.isArray(r.characters) ? r.characters : []).map((x) => String(x).toUpperCase());
  const wearing = {};
  // A pair pointing at a costume that has since been deleted is not "wearing
  // nothing" - it is a pair that lost its costume. The column is jsonb with no
  // foreign key, so a deleted costume leaves these behind, and reading them
  // literally undressed people whose outfit had merely been replaced.
  const liveOf = (row) =>
    Array.isArray(row.wardrobe) ? row.wardrobe.filter((w) => w && propList.some((x) => x.id === w.prop)) : [];
  const live = Array.isArray(r.wardrobe) ? liveOf(r) : null;
  if (live && (live.length > 0 || r.wardrobe.length === 0)) {
    for (const w of live) {
      const pr = propList.find((x) => x.id === w.prop);
      if (pr && pr.look) wearing[String(w.on).toUpperCase()] = pr.look;
    }
    return wearing;
  }

  // 2. The scene. First shot of the scene that says so wins, so a change of
  //    clothes later in the same scene still needs its own shots ticked.
  const mine = {};
  for (const row of allRows || []) {
    if (row.scene_number !== r.scene_number) continue;
    for (const w of liveOf(row)) {
      const pr = propList.find((x) => x.id === w.prop);
      const who = String(w.on).toUpperCase();
      if (pr && pr.look && !mine[who]) mine[who] = pr.look;
    }
  }
  for (const n of here) {
    const hit = Object.keys(mine).find((k) => k === n || n.includes(k) || k.includes(n));
    if (hit) wearing[n] = mine[hit];
  }

  // 3. The screenplay.
  const br = r.beat_id ? beats.find((b) => b.id === r.beat_id) : null;
  if (br && Array.isArray(br.characters)) {
    for (const c of br.characters) {
      const want = c && c.wardrobe ? String(c.wardrobe).trim().toLowerCase() : '';
      if (!want) continue;
      const pr = propList.find((x) => x.kind === 'wardrobe' && x.names.includes(want));
      if (!pr || !pr.look) continue;
      // The script writes "DR. EMMETT BROWN" where the cast list says "BROWN".
      const nm = String(c.name || '').toUpperCase();
      const who = here.find((n) => n === nm || nm.includes(n) || n.includes(nm));
      if (who && !wearing[who]) wearing[who] = pr.look;
    }
  }

  // 4. The costume's own wearer.
  for (const pr of propList) {
    if (pr.kind !== 'wardrobe' || !pr.wornBy || !pr.look) continue;
    if (!here.includes(pr.wornBy) || wearing[pr.wornBy]) continue;
    if (propList.filter((o) => o.kind === 'wardrobe' && o.wornBy === pr.wornBy).length === 1) {
      wearing[pr.wornBy] = pr.look;
    }
  }
  return wearing;
}

// ------------------------------------------- the shape of a shot
//
// Above every mode branch because the prompt composer below is shared: a redo
// rebuilds a prompt with the same sizes, heights and framings the plan used,
// and a const declared inside the plan path is invisible from up here.
const TYPES = ['establishing', 'wide', 'medium', 'close', 'reaction', 'cutaway', 'insert'];
// How close the shot is, asked separately from what it is FOR. The old single
// list mixed the two - "reaction" says the job and nothing about the framing, so
// the size was left to chance and two neighbouring shots could land on the same
// one, which reads as a glitch rather than a cut.
const SIZES = ['wide', 'full', 'medium', 'medium_close', 'close', 'insert'];
// Camera height and lens per size. A wide sits low so the place towers; a close
// sits at eye level because that is where a face is read from; an insert looks
// down at the object in a hand.
const HEIGHT = {
  wide: 'Wide lens, camera low and looking slightly up',
  full: 'Wide lens, camera at waist height',
  medium: 'Normal lens, camera at eye level',
  medium_close: 'Long lens, camera at eye level, background soft',
  close: 'Long lens, eye level, background thrown out of focus',
  insert: 'Close on the object, looking down at it'
};
// Where the subject sits in the frame. Centre is what a snapshot does; a face
// placed off to one side with the space it is looking into is what a shot does.
const OFFSET = {
  wide: 'horizon low, sky filling the top third',
  full: 'subject off-centre with room to walk into',
  medium: 'subject off-centre, looking into the empty side',
  medium_close: 'subject off-centre, looking into the empty side',
  close: 'eyes on the upper third, looking off-frame',
  insert: null
};
// A shot the model gave no size to still needs one, from its job.
const sizeFor = (t) =>
  ({ establishing: 'wide', wide: 'wide', medium: 'medium', close: 'close', reaction: 'medium_close', cutaway: 'medium', insert: 'insert' }[t] ||
  'medium');

if (mode === 'check') {
  return {
    action: 'dry_run',
    movie: movie.title,
    planId: parsed.planId || null,
    targetSeconds,
    beats: beats.length,
    scenes: sceneNumbers.size,
    characters: characters.map((c) => c.name),
    lines: lines.length,
    shots: coverageShots,
    runtime: clock(naturalSeconds),
    seconds: Number(naturalSeconds.toFixed(1)),
    breakdown: {
      dialogue: lines.length,
      reactions: requiredReactions,
      establishing: requiredEstablishing,
      masters: requiredMasters,
      action: actionShots
    },
    advice,
    note: 'Dry run: nothing was written.'
  };
}

// ========================================================= chainplan mode
// Translate a shot list we already drafted into the Context Loop pack's Plan
// format, plus the tagged picture references it needs (7b).
//
// It reads director_shots and writes nothing: no LLM call, no GPU, and - unlike
// plan mode - no refusal when the plan already has frames or clips, because a
// plan worth rendering is exactly one that has them.
//
// Character looks use the FULL visual_anchor, not the short hair+two-items form
// the frame prompts use. Opposite evidence for the two renderers: Klein got
// worse with extra clauses, while the Ref2VA test that held identity across 124
// frames used a long definition, as does the pack's own shipped example.
if (mode === 'chainplan' || mode === 'render' || mode === 'assemble') {
  // Its own tidier: the one used by the frame prompts is defined far below this
  // branch, and reaching down to it would be a ReferenceError.
  const clean0 = (t) => String(t || '').replace(/\s+/g, ' ').trim().replace(/[.\s]+$/, '');
  if (!parsed.planId) return { error: 'Pick a plan first - chainplan translates a plan that already exists.' };
  const cplan = (await records('director_plans', { id: `eq.${parsed.planId}`, select: 'id,movie_id,target_seconds' }))[0];
  if (!cplan || cplan.movie_id !== movie.id) return { error: 'That plan does not belong to this movie.' };
  const shotRows = await records('director_shots', {
    plan_id: `eq.${cplan.id}`,
    select: 'position,scene_number,shot_type,characters,length_frames,continuity,motion_prompt,notes,use_start_frame,use_frames,first_frame_path,wardrobe',
    order: 'position.asc'
  });
  if (!shotRows.length) return { error: 'That plan has no shots yet - draft a shot list first.' };

  // Characters again, this time with ids, so their sheets can be found.
  const cast = await records('characters', { movie_id: `eq.${movie.id}`, select: 'id,name,visual_anchor' });
  const castByName = {};
  for (const c of cast) castByName[String(c.name).toUpperCase()] = c;
  let sheets = [];
  if (cast.length) {
    sheets = await records('character_images', {
      character_id: `in.(${cast.map((c) => c.id).join(',')})`,
      select: 'character_id,kind,version,image_path',
      order: 'version.asc'
    });
  }
  // Newest sheet per character, falling back to the front QA view.
  const pictureOf = (id) => {
    const mine = sheets.filter((s) => s.character_id === id && s.image_path);
    const newest = (kind) => mine.filter((s) => s.kind === kind).slice(-1)[0];
    const pick = newest('sheet') || newest('qa_front') || mine.slice(-1)[0];
    return pick ? pick.image_path : null;
  };

  // The mirror of how 5.6 writes motion_prompt. Coupled to that format on
  // purpose: parsing what we ourselves emit is exact, where re-deriving from the
  // beats would drift from the shot list you approved.
  const parseMotion = (mp) => {
    let t = String(mp || '').trim();
    if (t.startsWith(STYLE.motion)) t = t.slice(STYLE.motion.length).trim();
    const d = t.match(/At (\d\d:\d\d\.\d\d\d), ([A-Z][A-Z0-9_]*) \(S1\) says: <d>\[English\] ([\s\S]*?)<\/d>/);
    if (d) {
      const cut = t.indexOf('. At ');
      const sm = t.match(/Overall soundscape: ([\s\S]*)$/);
      return {
        action: (cut > -1 ? t.slice(0, cut) : t).trim(),
        sound: sm ? sm[1].trim().replace(/\.\s*$/, '') : '',
        at: d[1], speaker: d[2], line: d[3].trim()
      };
    }
    const cut = t.indexOf('. The only sounds are');
    const sm = t.match(/The only sounds are ([\s\S]*?)\. Non-diegetic music/);
    return {
      action: (cut > -1 ? t.slice(0, cut) : t).trim(),
      sound: sm ? sm[1].trim() : '',
      at: null, speaker: null, line: null
    };
  };

  const usedTags = new Set();
  const usedProps = new Set();
  // Each shot's own approved first frame, registered as its own tag. Without it
  // a shot with no cast has nothing to anchor to: scene 1 of Starfall - an empty
  // rooftop at sunset - came back as a redheaded girl in a sailor uniform beside
  // a river, because the prompt was pure text and no tag applied to it.
  const frameRefs = [];
  const chainShots = shotRows.map((s, i) => {
    const m = parseMotion(s.motion_prompt);
    const names = (Array.isArray(s.characters) ? s.characters : []).map((n) => String(n).toUpperCase());
    // 5.5 - more than four on screen carries NO references; the frame is written
    // from behind. Registering tags here would contradict that.
    const tagged = names.length > 4 ? [] : names.filter((n) => castByName[n] && pictureOf(castByName[n].id));
    tagged.forEach((n) => usedTags.add(n));
    const tagOf = (n) => '@' + String(n).toLowerCase();
    const subjectOf = (n) => `<Subject ${tagged.indexOf(n) + 1}>`;

    const defs = tagged.map(
      (n) => `${tagOf(n)} defines ${subjectOf(n)}: ${clean0(castByName[n].visual_anchor || n)}`
    );
    if (tagged.length) {
      defs.push(
        `${tagged.map(subjectOf).join(' and ')} ${tagged.length > 1 ? 'are' : 'is'} shown by ${tagged
          .map(tagOf)
          .join(' and ')}. Preserve face, hair, wardrobe and proportions exactly.`
      );
    }

    const retention = tagged.map(
      (n) => `${subjectOf(n)} (appears in [Shot 1]): fully_preserved - retain the exact face, hair and wardrobe of ${tagOf(n)}.`
    );

    // Every tagged name in the action becomes its Subject label. The action came
    // from motion_prompt, written for our own renderer before tags existed, so
    // it still says "lands at CHIBI's feet" - a bare name beside <Subject 1>,
    // two labels for one person in one sentence, and CHIBI is a colour word
    // (5.5). Matched in UPPER or Title case only, never lower, so "a red glow"
    // is left alone.
    const asSubjects = (t) => {
      let out = String(t || '');
      for (const n of tagged) {
        const title = n[0] + n.slice(1).toLowerCase();
        out = out.replace(new RegExp(`\\b(?:${n}|${title})\\b`, 'g'), subjectOf(n));
      }
      return out;
    };

    // Props that appear in THIS shot, by any of their names, and that have a
    // rendered sheet. Words alone let the crystal change size shot to shot; the
    // sheet is what holds it still, exactly as a character sheet does.
    const saidHere = `${m.action} ${s.notes || ''}`.toLowerCase();
    const hereNames = new Set(names);
    const propsHere = propList.filter((p) => {
      if (!p.image_path) return false;
      // A costume follows the SHOT's choice where it has one - that is what
      // lets it come off mid-act - and otherwise its own wearer.
      if (p.kind === 'wardrobe') {
        // The shot says who wears what, both halves - a costume changes hands,
        // so the wearer cannot live on the costume. Entries whose costume has
        // been deleted are ignored rather than read as "wearing nothing".
        const live = Array.isArray(s.wardrobe)
          ? s.wardrobe.filter((w) => w && propList.some((x) => x.id === w.prop))
          : null;
        if (live && (live.length > 0 || s.wardrobe.length === 0)) {
          return live.some((w) => w.prop === p.id);
        }
        // Nothing said: fall back to the costume's own wearer, and only when
        // that person owns exactly one. Two costumes and nothing can choose
        // between them, so wearing neither beats wearing both.
        if (!p.wornBy || !hereNames.has(p.wornBy)) return false;
        return propList.filter((o) => o.kind === 'wardrobe' && o.wornBy === p.wornBy).length === 1;
      }
      return p.names.some((n) => saidHere.includes(n));
    });
    for (const p of propsHere) {
      usedProps.add(p.tag);
      defs.push(`@${p.tag} is the exact ${p.canonical}: ${p.look}. Match it exactly whenever it appears.`);
    }

    // The shot's own first frame, as a tag. It carries framing, location and
    // light - the things a cast tag cannot - so a shot with nobody in it is
    // still anchored to the picture that was approved.
    const frameTag = s.first_frame_path ? 'frame_' + String(s.position).padStart(3, '0') : null;
    if (frameTag) {
      frameRefs.push({ tag: frameTag, image_path: s.first_frame_path });
      defs.push(`@${frameTag} is the exact opening frame of this shot: its framing, location, lighting and staging.`);
    }

    // The speaker is named as their Subject so the dialogue attaches to the
    // reference rather than to a bare name (5.5 - these names are colour words).
    let described = `[Shot 1] ${STYLE.motion}`;
    if (frameTag) described += ` Begin exactly as shown in @${frameTag}, matching its framing, location and light.`;
    described += ` ${asSubjects(m.action)}.`;
    // Whatever is not stated gets invented. Scene 1 opened on the right empty
    // rooftop and then a girl walked into it, because nothing said the shot has
    // nobody in it. Their own example is explicit for exactly this reason:
    // "exactly one courier and one bicycle ... no duplicate subject, added
    // customer". So every shot states its population, not just the empty ones -
    // otherwise a two-hander quietly acquires a third.
    if (!names.length) {
      described += ' No people appear in this shot; the location stays empty for its whole length.';
    } else {
      const who = tagged.length ? tagged.map(subjectOf).join(' and ') : names.join(' and ');
      described += ` Exactly ${names.length} ${names.length === 1 ? 'person appears' : 'people appear'} in this shot: ${who}. No one else enters at any point.`;
    }
    if (m.line) {
      const who = tagged.includes(m.speaker) ? subjectOf(m.speaker) : m.speaker;
      described += ` At ${m.at}, ${who} (S1) says: <d>[English] ${m.line}</d>`;
    }

    const prompt = [
      'subject_definitions:',
      ...(defs.length ? defs : ['No character references are active for this shot.']),
      '',
      'summary:',
      // The action, not `notes`: notes appends the spoken line, which would put
      // the dialogue in the prompt twice - here and again in
      // detailed_description - and bring the bare name back with it.
      `[reference generation] ${asSubjects(clean0(m.action)) || 'The moment holds'}`,
      '',
      ...(retention.length ? ['retention_analysis:', ...retention, ''] : []),
      'detailed_description:',
      described,
      '',
      'overall_soundscape:',
      m.sound || 'a soft breeze',
      '',
      'non_diegetic_music:',
      'No non-diegetic music.'
    ].join('\n');

    // How this shot joins the one before it. Left unset, the pack falls back to
    // context_length 22 / guide / generated_audio (H3_CHAIN_FORMAT_GUIDE 177),
    // where only picture crosses the boundary and every clip invents its sound
    // again. Set it per shot instead:
    //
    //   continue          -> masked_av at 39 frames. The AV modes place a
    //                        matching AUDIO prefix in the target latent and
    //                        masked_av protects it exactly, so sound carries
    //                        through. 39 is the smallest of the shared-clock
    //                        lengths AV accepts (39/90/141/192/243) - 22 is not
    //                        one of them, which is why guide cannot carry audio.
    //   fresh, same scene -> guide, keeping the 22-frame audio carry so the bed
    //                        runs on across the cut.
    //   fresh, new scene  -> guide with no audio carry: a new location should
    //                        not inherit the last one's room tone.
    //
    // Shot 1 has no predecessor, so it carries none of this.
    const prev = i > 0 ? shotRows[i - 1] : null;
    const sameScene = prev && prev.scene_number === s.scene_number;
    const joins = !prev
      ? {}
      : s.continuity === 'continue'
        ? { continuation_mode: 'masked_av', context_length: 39 }
        : { continuation_mode: 'guide', context_length: 22, audio_context_length: sameScene ? 22 : 0 };

    return {
      id: `shot_${String(s.position).padStart(3, '0')}`,
      prompt,
      length: s.length_frames,
      steps: 20,
      seed: String(7000 + s.position),
      ...joins,
      // Ours, carried through for the tab - the pack ignores unknown fields.
      _position: s.position,
      _scene: s.scene_number,
      _type: s.shot_type,
      _continuity: s.continuity,
      _use_start_frame: s.use_start_frame,
      _use_frames: s.use_frames
    };
  });

  const chainPlan = {
    prompt_prefix: [`${STYLE.motion} Keep the same characters, wardrobe and location across every scene.`],
    defaults: { steps: 20 },
    shots: chainShots
  };
  // One MiniMaxH3TaggedPictureReference per character, then one per shot for its
  // approved first frame, chained in this order. Registering them all is safe:
  // only the tags a scene's prompt actually mentions become active, so no scene
  // goes near H3's nine picture slots (its own frame plus at most four cast).
  const tagList = [
    ...[...usedTags].map((n) => ({
      tag: String(n).toLowerCase(),
      character: n,
      image_path: pictureOf(castByName[n].id)
    })),
    // Prop sheets, registered like character sheets - only the ones some shot
    // actually mentions, so nothing unused is carried into the chain.
    ...propList
      .filter((p) => p.image_path && usedProps.has(p.tag))
      .map((p) => ({ tag: p.tag, character: null, image_path: p.image_path })),
    ...frameRefs.map((f) => ({ tag: f.tag, character: null, image_path: f.image_path }))
  ];

  if (mode === 'chainplan') {
    return {
      action: 'chainplan',
      movie: movie.title,
      planId: cplan.id,
      shots: chainShots.length,
      plan: chainPlan,
      tags: tagList,
      note: 'Nothing was written or rendered - this is the plan to hand to the Context Loop graph.'
    };
  }

  // ========================================================== render mode
  // One scene of the Context Loop chain, queued straight into ComfyUI (7b).
  //
  // One scene per call on purpose: their loop renders a scene, checkpoints it
  // and stops, and a 26-scene film is hours - which no single request should
  // hold open. The browser repeats the call, exactly as the frames and clips
  // stages already do, so stop and resume keep working.
  const fs = require('fs');
  const path = require('path');
  const COMFY_ROOT = String($comfyRoot || 'C:/ComfyUI2').replace(/[\\/]+$/, '');
  const PACK_WF = COMFY_ROOT + '/custom_nodes/ComfyUI-MiniMaxH3-Context-Loop/example_workflows/Ref2V Tagged - MiniMax H3 0.6.json';
  const scene = Math.max(1, Math.min(chainShots.length, Math.round(Number(parsed.scene) || 1)));
  // Stable per plan, so every scene of the same plan resumes the same run.
  const runName = 'director-' + String(cplan.id).slice(0, 8);

  if (!fs.existsSync(PACK_WF)) return { error: 'The Context Loop pack is not installed: ' + PACK_WF };
  const wf = JSON.parse(fs.readFileSync(PACK_WF, 'utf8'));
  const byId = new Map(wf.nodes.map((n) => [n.id, n]));
  const setW = (id, i, v) => {
    const n = byId.get(id);
    if (n && Array.isArray(n.widgets_values)) n.widgets_values[i] = v;
  };
  setW(2, 0, 'qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors'); // the encoder we have
  // Render at the shape of the first frames, not the example's.
  //
  // The pack's Ref2V Tagged example ships 896x672 - 4:3 - and we inherited it,
  // so every clip and every cut came out boxy while the first frame the
  // operator approved is 1344x768 widescreen (DirectorPanel FRAME_W/FRAME_H).
  // The pack fits references to the Plan's width/height, so the approved
  // composition was being refitted on the way in. Matching the two exactly
  // means what you approve is what renders.
  setW(24, 3, 1344); // width
  setW(24, 4, 768); // height
  setW(24, 0, JSON.stringify(chainPlan, null, 2));
  setW(24, 1, runName);
  setW(7, 0, scene); // Loop Start start_clip
  setW(7, 1, String(scene)); // scene_range - this one scene only
  setW(31, 0, scene); // Preflight start_clip
  setW(31, 1, String(scene));
  setW(25, 0, false); // the Review Gate waits for a click; headless that is a stall

  // LoadImage reads ComfyUI's input/ folder, but character sheets are output/
  // paths, so each one is copied in first.
  const stagedDir = path.join(COMFY_ROOT, 'input', '_director_tags');
  fs.mkdirSync(stagedDir, { recursive: true });
  const staged = [];
  for (const t of tagList) {
    if (!t.image_path) continue;
    const src = path.join(COMFY_ROOT, String(t.image_path).split('\\').join('/'));
    if (!fs.existsSync(src)) continue;
    const file = t.tag + path.extname(src);
    fs.copyFileSync(src, path.join(stagedDir, file));
    staged.push({ tag: t.tag, file: '_director_tags/' + file });
  }
  if (!staged.length) return { error: 'No character sheets could be staged - nothing to reference.' };

  // -------------------------------------------------- UI graph -> API graph
  // ComfyUI's /prompt takes a flat map, not the editor's nodes+links. COMBO is
  // declared as the STRING "COMBO" here, and widgets_values carries a value for
  // every widget-eligible input INCLUDING link-connected ones - miss either and
  // every value after it slides up by one.
  const WIDGET_TYPES = new Set(['INT', 'FLOAT', 'STRING', 'BOOLEAN', 'COMBO']);
  const oi = (await axios.get(`${comfyUrl}/object_info`)).data;
  const linkMap = new Map();
  for (const l of wf.links || []) linkMap.set(l[0], [l[1], l[2]]);
  const api = {};
  // Assemble runs the pack's RECOVERY pair, which ships muted: Manifest Load
  // (#26) reads every clip already checkpointed in this run's folder and hands
  // Assemble (#9) a COMPLETE manifest. The in-chain assemble (#21) only ever
  // sees the clips of the scene that just rendered, which is why a render's
  // "final" is one shot long.
  const FORCE = mode === 'assemble' ? new Set([26, 9]) : new Set();
  for (const n of wf.nodes) {
    if (!oi[n.type]) continue;
    if ((n.mode === 4 || n.mode === 2) && !FORCE.has(n.id)) continue;
    const spec = oi[n.type].input || {};
    const ord = oi[n.type].input_order || {
      required: Object.keys(spec.required || {}),
      optional: Object.keys(spec.optional || {})
    };
    const linked = new Map();
    for (const i of n.inputs || []) if (i.link != null) linked.set(i.name, i.link);
    const widgets = Array.isArray(n.widgets_values) ? [...n.widgets_values] : [];
    const inputs = {};
    for (const name of [...(ord.required || []), ...(ord.optional || [])]) {
      const def = (spec.required || {})[name] || (spec.optional || {})[name];
      if (!def) continue;
      const t = def[0];
      const isWidget = Array.isArray(t) || (typeof t === 'string' && WIDGET_TYPES.has(t));
      let v;
      if (isWidget && widgets.length) v = widgets.shift();
      if (linked.has(name)) {
        const s = linkMap.get(linked.get(name));
        if (s) inputs[name] = [String(s[0]), s[1]];
        continue;
      }
      if (!isWidget) continue;
      if (v !== undefined) inputs[name] = v;
    }
    api[String(n.id)] = { class_type: n.type, inputs };
  }

  // ------------------------------------------- rebuild the reference chain
  // The graph ships two tagged pairs; a film has as many as it has characters.
  // The TAIL of the chain feeds three places - the conditioning node, preflight,
  // and the Plan's generation_fingerprint, which is what invalidates a
  // checkpoint when the cast changes. Miss the fingerprint and a stale
  // checkpoint would happily resume against different references.
  for (const id of ['27', '28', '29', '30']) delete api[id];
  let prevRef = null;
  staged.forEach((s, i) => {
    const img = String(900 + i);
    const ref = String(950 + i);
    api[img] = { class_type: 'LoadImage', inputs: { image: s.file } };
    api[ref] = { class_type: 'MiniMaxH3TaggedPictureReference', inputs: { image: [img, 0], tag: s.tag } };
    if (prevRef) api[ref].inputs.previous = [prevRef, 0];
    prevRef = ref;
  });
  api['11'].inputs.references = [prevRef, 0];
  api['31'].inputs.tagged_references = [prevRef, 0];
  api['24'].inputs.generation_fingerprint = [prevRef, 1];

  // ComfyUI executes every OUTPUT node and whatever it depends on. Keeping only
  // node 9's closure drops Segment Save (#20), the in-chain Assemble (#21) and
  // Review (#25), which leaves the sampler unreachable - so this stitches clips
  // already on disk and costs no GPU time.
  if (mode === 'assemble') {
    api['9'].inputs.filename = 'cut';
    const keep = new Set();
    const walk = (id) => {
      if (keep.has(id) || !api[id]) return;
      keep.add(id);
      for (const v of Object.values(api[id].inputs)) {
        if (Array.isArray(v) && v.length === 2 && typeof v[0] === 'string') walk(v[0]);
      }
    };
    walk('9');
    for (const id of Object.keys(api)) if (!keep.has(id)) delete api[id];
  }

  const q = await axios.post(`${comfyUrl}/prompt`, { prompt: api }, { validateStatus: () => true });
  const promptId = q.data && q.data.prompt_id;
  if (!promptId) {
    return {
      action: 'error',
      scene,
      reason: 'ComfyUI refused the graph.',
      detail: JSON.stringify((q.data && (q.data.node_errors || q.data.error)) || q.data).slice(0, 1200)
    };
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let rec = null;
  for (let i = 0; i < 240; i++) {
    await sleep(10000);
    try {
      const h = await axios.get(`${comfyUrl}/history/${promptId}`);
      const r = h.data && h.data[promptId];
      if (r && r.status && r.status.status_str) {
        rec = r;
        break;
      }
    } catch (e) {}
  }
  if (!rec) return { action: 'pending', scene, promptId, reason: 'Still rendering past the check window.' };
  if (rec.status.status_str === 'error') {
    return {
      action: 'error',
      scene,
      promptId,
      reason: JSON.stringify((rec.status.messages || []).filter((m) => m[0] === 'execution_error')).slice(0, 1200)
    };
  }

  // The segment the loop just wrote, newest first.
  const segDir = path.join(COMFY_ROOT, 'output', 'h3_chains', runName, 'segments');
  let segment = null;
  try {
    const mp4s = fs
      .readdirSync(segDir)
      .filter((f) => f.endsWith('.mp4'))
      .map((f) => ({ f, t: fs.statSync(path.join(segDir, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t);
    if (mp4s[0]) segment = 'output/h3_chains/' + runName + '/segments/' + mp4s[0].f;
  } catch (e) {}

  if (mode === 'assemble') {
    const finalDir = path.join(COMFY_ROOT, 'output', 'h3_chains', runName, 'final');
    let cut = null;
    try {
      const mp4s = fs
        .readdirSync(finalDir)
        .filter((f) => f.endsWith('.mp4'))
        .map((f) => ({ f, t: fs.statSync(path.join(finalDir, f)).mtimeMs }))
        .sort((a, b) => b.t - a.t);
      if (mp4s[0]) cut = 'output/h3_chains/' + runName + '/final/' + mp4s[0].f;
    } catch (e) {}
    if (!cut) return { action: 'error', reason: 'Assemble finished but wrote no file in ' + finalDir };
    // The plan carries the cut so the panel can show it and so the stage reads
    // "done" instead of "-".
    const up = await axios.patch(
      `${insforgeUrl}/api/database/records/director_plans?id=eq.${cplan.id}`,
      { output_path: cut },
      { headers: jsonHeaders, validateStatus: () => true }
    );
    // The clips actually joined, not the shots in the plan - a plan of 26 with
    // 3 rendered assembles to 3, and saying 26 would read as a finished film.
    let joined = 0;
    try {
      joined = fs
        .readdirSync(path.join(COMFY_ROOT, 'output', 'h3_chains', runName, 'segments'))
        .filter((f) => f.endsWith('.mp4')).length;
    } catch (e) {}
    return {
      action: 'assembled',
      runName,
      promptId,
      cut,
      clips: joined,
      ofShots: chainShots.length,
      saved: up.status >= 200 && up.status < 300,
      note: up.status >= 200 && up.status < 300 ? 'Cut assembled from every clip in the run folder.' : 'Cut written, but the plan could not be updated: HTTP ' + up.status
    };
  }

  return {
    action: 'rendered',
    scene,
    of: chainShots.length,
    shotPosition: chainShots[scene - 1] && chainShots[scene - 1]._position,
    runName,
    promptId,
    segment,
    tags: staged.map((s) => s.tag),
    note: segment ? 'Scene rendered. Call again with the next scene number.' : 'Finished, but no segment file was found.'
  };
}

// ============================================================ rebind mode
//
// 5.19 - rewrite the prompts of shots that already exist.
//
// This is what Redo calls before it renders. The order is: work out what each
// person in the shot is wearing, rebuild the prompt around that, and only then
// render - so the picture and the words are asking for the same thing.
//
// It REBUILDS. It does not edit. The first version of this found the old clause
// in the prompt and swapped the new one in, which is how one prompt ended up
// carrying the same trench coat six times over: a prompt names a person more
// than once, the swap could not tell which mention it had already done, and
// every run added another. Now the script's own words (raw_frame, raw_action)
// are composed again from today's tables, by the same composeShot() the draft
// uses, and whatever the prompt said before is simply gone.
//
// Per shot and per person. A costume reaches the people in THAT shot and nobody
// else: a shot with only a character in it never hears about BROWN's coat, and anyone
// in the shot with no costume chosen keeps their own description, untouched.
if (mode === 'rebind') {
  if (!parsed.planId) return { error: 'Pick a plan first - this rewrites the prompts of a plan.' };
  const rp = (await records('director_plans', { id: `eq.${parsed.planId}`, select: 'id,movie_id' }))[0];
  if (!rp || rp.movie_id !== movie.id) return { error: 'That plan does not belong to this movie.' };

  const from = Math.max(0, Math.round(Number(parsed.fromPos) || 0));
  const to = Math.max(0, Math.round(Number(parsed.toPos) || 0));
  // An explicit list wins over a range: Redo rewrites the shots being redone and
  // nothing else, and those are not necessarily next to each other.
  const only = Array.isArray(parsed.positions) ? parsed.positions.map(Number) : null;
  const all = await records('director_shots', {
    plan_id: `eq.${rp.id}`,
    select:
      'id,position,scene_number,beat_id,characters,shot_type,shot_size,foreground,' +
      'frame_prompt,motion_prompt,wardrobe,raw_frame,raw_action',
    order: 'position.asc'
  });
  const rows = all.filter((r) =>
    only ? only.includes(r.position) : (!from || r.position >= from) && (!to || r.position <= to)
  );
  if (!rows.length) return { error: 'No shots in that range.' };

  const beatById = {};
  for (const b of beats) beatById[b.id] = b;

  // A costume assigned to a person holds FOR THAT SCENE.
  //
  // Ticking every shot someone appears in is not how clothes work: you dress them
  // for a scene, and they stay dressed until the script changes it. Without this,
  // only the ticked shots carried the choice - so one shot had a character in the puffer
  // vest and the next, same scene, same minute, had him back in his denim shirt,
  // because he owns two outfits and nothing outside the ticked shots could choose
  // between them. That reads as a continuity error, which is what it is.
  //
  // Scene-scoped and no wider: a costume put on in the parking lot says nothing
  // about what anyone wears in the next scene, which is the point of being able
  // to take it off mid-film.
  const sceneChoice = {};
  for (const r of all) {
    const live = Array.isArray(r.wardrobe) ? r.wardrobe.filter((w) => w && propList.some((x) => x.id === w.prop)) : [];
    if (!live.length) continue;
    const key = String(r.scene_number);
    sceneChoice[key] = sceneChoice[key] || {};
    for (const w of live) {
      const pr = propList.find((x) => x.id === w.prop);
      // First shot of the scene that says so wins, so a later change of clothes
      // inside one scene still needs its own shots ticked - it does not get
      // overwritten by the earlier half of the scene.
      const who = String(w.on).toUpperCase();
      if (pr && pr.look && !sceneChoice[key][who]) sceneChoice[key][who] = pr.look;
    }
  }

  // The scene look, word for word as it was written into the prompt. It is the
  // model's wording from draft time and is not stored in a column of its own, so
  // it is read back out of the prompt it was written into - a read, not an edit.
  // Without it a rebuilt prompt would lose the one line that makes the cuts
  // inside a scene match.
  const lookOfShot = (r) => {
    const m = /Setting:\s*([^.]*)\./.exec(String(r.frame_prompt || ''));
    if (m && clean(m[1])) return clean(m[1]);
    const sc = sceneByNum[r.scene_number] || {};
    return clean(sc.location_description) || clean(sc.location_name) || 'the same place';
  };

  // Which line this shot carries, recovered from the prompt it was written into
  // for the same reason. Matched on the words themselves, so it is either the
  // right line or no line at all.
  const lineOfShot = (r) => {
    const m = /<d>\[English\]\s*([\s\S]*?)<\/d>/.exec(String(r.motion_prompt || ''));
    if (!m) return null;
    const said = clean(m[1]);
    return lines.find((l) => clean(l.text) === said) || null;
  };

  const changed = [];
  const skipped = [];
  const dressed = [];
  for (const r of rows) {
    // No kept wording, no rebuild. A prompt from before raw_frame existed cannot
    // be rebuilt from anything, and guessing at it is what the old patching did.
    if (!clean(r.raw_frame)) {
      skipped.push(`shot ${r.position}: no script wording kept for it, so there is nothing to rebuild from`);
      continue;
    }

    const here = (Array.isArray(r.characters) ? r.characters : []).map((x) => String(x).toUpperCase());

    // What each person in this shot is wearing. One rule, shared with the review
    // pass and mirrored in the tab, so the words, the reference picture and the
    // check can never disagree about it again.
    const wearing = costumesFor(r, all);

    const composed = composeShot({
      label: String(r.position),
      scene: r.scene_number,
      sceneRow: sceneByNum[r.scene_number] || {},
      look: lookOfShot(r),
      type: r.shot_type,
      size: r.shot_size,
      foreground: r.foreground,
      names: here,
      // The model's from_behind and subjects wordings belong to the draft that is
      // gone. Props are read from the table, which is the authority anyway, and a
      // shot with more than four people falls back to each person's own anchor.
      fromBehind: {},
      subjects: {},
      frame: r.raw_frame,
      action: r.raw_action,
      line: lineOfShot(r),
      sound: null,
      unnamed: [],
      costumes: wearing
    });

    // Identical means nothing changed, and writing it would only move the
    // timestamp - which is the one thing that says whether a redo did anything.
    if (composed.frame_prompt === r.frame_prompt && composed.motion_prompt === r.motion_prompt) continue;

    const up = await axios.patch(
      `${insforgeUrl}/api/database/records/director_shots`,
      { frame_prompt: composed.frame_prompt, motion_prompt: composed.motion_prompt },
      { params: { id: `eq.${r.id}` }, headers: jsonHeaders, validateStatus: () => true }
    );
    if (up.status < 200 || up.status >= 300) {
      skipped.push(`shot ${r.position}: the rewrite did not save (HTTP ${up.status})`);
      continue;
    }
    changed.push(r.position);
    for (const n of Object.keys(wearing)) dressed.push(`${n} in shot ${r.position}`);
  }

  // Upstream: the screenplay is told what these people are wearing, so a redraft
  // finds it on the beat and keeps it instead of silently undressing everyone
  // from a script that never mentioned the costume. Only the beats of the shots
  // just rewritten, and only the people in them.
  const upstream = [];
  const byBeat = {};
  for (const r of rows) {
    if (!r.beat_id || !changed.includes(r.position)) continue;
    const live = Array.isArray(r.wardrobe) ? r.wardrobe.filter((w) => w && propList.some((x) => x.id === w.prop)) : [];
    if (!live.length) continue;
    byBeat[r.beat_id] = byBeat[r.beat_id] || {};
    for (const w of live) {
      const pr = propList.find((x) => x.id === w.prop);
      if (pr) byBeat[r.beat_id][String(w.on).toUpperCase()] = pr.canonical;
    }
  }
  for (const [beatId, who] of Object.entries(byBeat)) {
    const br = beatById[beatId];
    if (!br || !Array.isArray(br.characters)) continue;
    let moved = false;
    const next = br.characters.map((c) => {
      const nm = String((c && c.name) || '').toUpperCase();
      const hit = Object.keys(who).find((n) => n === nm || nm.includes(n) || n.includes(nm));
      if (!hit || c.wardrobe === who[hit]) return c;
      moved = true;
      // Spread, so `presence` and anything else on the entry survives - dropping
      // it would turn a voice-only character into an on-screen one.
      return { ...c, wardrobe: who[hit] };
    });
    if (!moved) continue;
    const up = await axios.patch(
      `${insforgeUrl}/api/database/records/beats`,
      { characters: next },
      { params: { id: `eq.${beatId}` }, headers: jsonHeaders, validateStatus: () => true }
    );
    if (up.status >= 200 && up.status < 300) {
      upstream.push(`${br.beat_code}: ${Object.entries(who).map(([n, c]) => `${n} in ${c}`).join(', ')}`);
    } else {
      skipped.push(`${br.beat_code}: the screenplay did not take the costume (HTTP ${up.status})`);
    }
  }

  return {
    action: 'rebound',
    checked: rows.length,
    changed: changed.length,
    positions: changed,
    dressed: [...new Set(dressed)],
    upstream,
    missed: skipped,
    note: changed.length
      ? `${changed.length} prompt(s) rewritten from the script and today's wardrobe.` +
        (upstream.length ? ` The screenplay now says so too (${upstream.join('; ')}).` : '')
      : 'Every prompt already said exactly this - nothing to rewrite.'
  };
}

// ============================================================ review mode
//
// 5.16 - the continuity pass. Runs AFTER first frames and BEFORE clips, which is
// the only moment both signals exist: the text is written, the pictures are
// rendered, and no clip time has been spent yet.
//
// Every neighbouring pair in a scene is read twice - once as text, once as
// picture - and the two readings are compared. When they disagree the remedy
// depends on WHICH SIDE disagrees with its own text:
//
//   the earlier frame contradicts its own text  -> redo_prev
//   the later frame contradicts its own text    -> redo_next
//   both frames match their text, but the pair
//   cannot be cut together                      -> needs_shot
//
// The text is authoritative because it came from the script. When a picture
// argues with it, the picture loses. When the text itself skips a move, no
// re-render can fix it and a shot has to go between - which is the shimmy,
// found rather than typed.
if (mode === 'review') {
  // Its own tidier. The one the chainplan branch uses is defined inside that
  // branch, and reaching down to it from here would be a ReferenceError.
  const tidy0 = (t) => String(t || '').replace(/\s+/g, ' ').trim().replace(/[.\s]+$/, '');
  if (!parsed.planId) return { error: 'Pick a plan first - review reads the shots of a plan.' };
  const rplan = (await records('director_plans', { id: `eq.${parsed.planId}`, select: 'id,movie_id' }))[0];
  if (!rplan || rplan.movie_id !== movie.id) return { error: 'That plan does not belong to this movie.' };

  const from = Math.max(0, Math.round(Number(parsed.fromPos) || 0));
  const to = Math.max(0, Math.round(Number(parsed.toPos) || 0));
  const all = await records('director_shots', {
    plan_id: `eq.${rplan.id}`,
    select:
      'id,position,scene_number,beat_id,characters,wardrobe,frame_prompt,motion_prompt,notes,raw_frame,' +
      'first_frame_path,shot_size',
    order: 'position.asc'
  });
  const shotsToCheck = all.filter((s) => (!from || s.position >= from) && (!to || s.position <= to));
  if (shotsToCheck.length < 2) return { error: 'Fewer than two shots in that range - nothing to compare.' };

  const fs2 = require('fs');
  const path2 = require('path');
  const COMFY_ROOT2 = String($comfyRoot || 'C:/ComfyUI2').replace(/[\\/]+$/, '');

  // Specific questions, not "do these match". A similarity judgement from a
  // vision model is a number nobody can act on; a list of who is where compares
  // exactly and says what to put in the repair prompt.
  const LOOK = [
    'Describe only what is literally visible in this film frame. Answer as JSON, no prose:',
    '{"people":[{"who":"a short description","where":"screen-left|centre|screen-right","doing":"standing|sitting|holding something|operating something|walking"}],',
    ' "objects":[{"what":"...","where":"screen-left|centre|screen-right"}],',
    ' "place":"a few words for the location"}',
    'If nobody is visible, people is an empty list. Do not guess at anything off-frame.'
  ].join('\n');

  /**
   * The missing shot, written for you.
   *
   * A `needs_shot` finding says a move is never seen - someone is beside the car
   * in one shot and behind the wheel in the next. Until now that was where the
   * automation stopped and you typed the shot yourself, which is odd, because by
   * the time the finding exists everything needed to write it is already known:
   * the shot before, the shot after, and what the vision pass saw each person
   * doing in each frame.
   *
   * It writes the ACTION only - one sentence, in the script's own register. That
   * sentence is what the insert path already takes, and the insert runs it through
   * the SAME builder a planned shot goes through, so the inserted shot comes out
   * carrying the character anchors, the wardrobe, the camera line and the scene's
   * light and sound. Nothing here writes a prompt; that would be a second builder
   * and the two would drift.
   *
   * A proposal, never applied on its own: it lands in the finding and the operator
   * reads it before anything is inserted.
   */
  const bridgeAction = async (a, b) => {
    const q = [
      'Two shots of a film do not cut together: the first leaves people in one position, and the next',
      'shows them already somewhere else. The move between is never seen.',
      '',
      `Shot ${a.position}: ${clean(a.raw_frame) || clean(a.frame_prompt).slice(0, 200)}`,
      `Shot ${b.position}: ${clean(b.raw_frame) || clean(b.frame_prompt).slice(0, 200)}`,
      '',
      'Write the ONE shot that goes between them.',
      '- What HAPPENS, in one short sentence, in plain words from the shots above.',
      '- It starts where the first shot leaves off and ends where the second begins.',
      '- Name people by the NAMES used above, in capitals.',
      '- Never mention the camera, and invent nothing the two shots do not already imply.',
      // The posture words the vision pass reports ("standing", "holding
      // something") used to be handed over as well, and they were simply parroted
      // back: one gap came out as "BROWN and a character move from standing to holding
      // something", which is the two labels joined by "move from", not a shot.
      // The shots' own wording is far richer, and it is the script's.
      '- Write the MOVE itself - what someone does to get from the first shot to the second. Never describe',
      '  it as a change of posture, and never use the words "standing", "holding something" or "moves from".',
      '',
      'Return ONLY JSON: {"action":"..."}'
    ]
      .filter((x) => x !== '')
      .join('\n');
    try {
      const res = await llmChat(
        {
          model: ollamaModel,
          stream: false,
          think: false,
          options: { temperature: 0.2 },
          format: 'json',
          messages: [{ role: 'user', content: q }]
        },
        { timeout: 300000 }
      );
      const out = JSON.parse(((res.data && res.data.message && res.data.message.content) || '').trim());
      const act = clean(out && out.action);
      // A model that answers with the word rather than a value, again.
      return nothing(act) ? '' : act;
    } catch (e) {
      // Silent: a finding with no proposal is still a finding, and the operator
      // can type the shot as before. Failing the whole review over it would be
      // worse than leaving one box empty.
      return '';
    }
  };

  const seen = new Map(); // one vision call per frame, not one per pair
  const lookAt = async (rel) => {
    if (seen.has(rel)) return seen.get(rel);
    let out = null;
    try {
      const abs = path2.join(COMFY_ROOT2, String(rel).split('\\').join('/'));
      const bytes = fs2.readFileSync(abs);
      const res = await llmChat(
        {
          model: ollamaModel,
          stream: false,
          think: false,
          options: { temperature: 0.1 },
          format: 'json',
          messages: [{ role: 'user', content: LOOK, images: [bytes.toString('base64')] }]
        },
        { timeout: 300000 }
      );
      const txt = ((res.data && res.data.message && res.data.message.content) || '').trim();
      out = JSON.parse(txt);
    } catch (e) {
      out = null; // unreadable frame or no answer - reported, never guessed at
    }
    seen.set(rel, out);
    return out;
  };

  const side = (v) => {
    const t = String(v || '').toLowerCase();
    if (t.includes('left')) return 'left';
    if (t.includes('right')) return 'right';
    if (t.includes('centre') || t.includes('center')) return 'centre';
    return '';
  };
  const textOf = (s) => `${s.frame_prompt || ''} ${s.notes || ''}`;
  const MOVED2 = /\b(?:behind the wheel|at the wheel|inside|in the driver|seated|sitting in|sits in|holding|carrying|driving|riding|aboard)\b/i;
  const STATIC2 = /\b(?:stands?|standing|waits?|waiting|beside|next to|in front of|outside|watches?|watching|looks? at)\b/i;
  const doingMoved = (p) => MOVED2.test(`${p.doing || ''}`) || /operat|sitting|holding/i.test(`${p.doing || ''}`);

  const findings = [];

  // ---- identity: is the thing in the picture the thing we described?
  //
  // Seen in a real render: the a vehicle came back as a brown sedan and Doc was
  // in a coat instead of the radiation suit. Both are checkable, because the
  // authoritative description already exists - `movie_props.description` for a
  // prop or costume, `characters.visual_anchor` for a person - and the shot's
  // own text says which ones should be there.
  //
  // Asked as a targeted yes/no against one description at a time rather than as
  // a free comparison: "does the car in this frame match this?" is answerable,
  // "describe everything and let code diff it" is not - "stainless steel covered
  // in circuit boards" versus "brown sedan" needs judgement, not string
  // matching.
  const idCache = new Map();
  const matches = async (rel, label, description, strict) => {
    const key = rel + '||' + label + (strict ? '||strict' : '');
    if (idCache.has(key)) return idCache.get(key);
    let out = null;
    try {
      const abs = path2.join(COMFY_ROOT2, String(rel).split('\\').join('/'));
      const bytes = fs2.readFileSync(abs);
      const q = [
        `In this film frame, find the ${label}.`,
        `It is supposed to look like this: ${description}`,
        'Answer as JSON, no prose: {"present":true|false,"match":true|false,"seen":"what is actually there, in a few words"}.',
        'present is false only if you cannot find it in the frame at all.',
        // A description is always more detailed than a frame can show, and this
        // was being read as a checklist: a shot whose frame showed "a red puffer
        // vest over a plaid shirt" was failed against a description asking for a
        // red puffer vest over a plaid shirt, because the collar and the cuffs
        // were not visible at that size. Each of those costs a re-render to
        // produce the same picture again, so the bar is contradiction, not
        // completeness.
        'match is false ONLY if what you can see plainly CONTRADICTS the description - a different colour, a',
        'different garment, a different kind of object. Details that are missing, too small to make out, or',
        'hidden by the framing are still a match. If you are in any doubt, answer match: true.',
        // The lenient bar above is right for a description, which is always more
        // detailed than a frame can show. It is wrong for a costume that was
        // chosen: there the outfit IS the instruction, and giving it the benefit
        // of the doubt lets the wrong clothes through unremarked.
        ...(strict
          ? [
              '',
              'This one is STRICTER, because the clothing described here was deliberately chosen for this shot',
              'rather than written down from a picture. Judge the GARMENTS closely: if the colour, the type of',
              'clothing or the layering you can see differs from the description, that is match: false, even',
              'where the rest of the person is right. Only what is genuinely hidden or too small to see is',
              'excused.'
            ]
          : [])
      ].join('\n');
      const res = await llmChat(
        {
          model: ollamaModel,
          stream: false,
          think: false,
          options: { temperature: 0.1 },
          format: 'json',
          messages: [{ role: 'user', content: q, images: [bytes.toString('base64')] }]
        },
        { timeout: 300000 }
      );
      out = JSON.parse(((res.data && res.data.message && res.data.message.content) || '').trim());
    } catch (e) {
      out = null;
    }
    idCache.set(key, out);
    return out;
  };

  // Only things this shot's own text actually names, and only things that have a
  // description to check against - there is nothing to compare an undescribed
  // prop to, and a checker that complains about those would be noise.
  const castById = {};
  for (const c of characters) castById[String(c.name).toUpperCase()] = c;
  for (const s of shotsToCheck) {
    if (!s.first_frame_path) continue;

    // HOW MANY PEOPLE ARE IN THE FRAME.
    //
    // The pass asked what was in a shot and whether each thing matched its
    // description - never how many of them there were. So the most visible
    // failure a diffusion renderer produces went straight through: the same
    // person rendered twice, standing beside themselves. Two of someone matches
    // their description perfectly.
    //
    // This is a COUNT, not a judgement. The vision pass already reports the
    // people it can see, and the shot already lists who is meant to be there, so
    // the comparison needs no model and cannot be talked out of it.
    //
    // Only when the frame shows MORE than the shot asked for. Fewer is often
    // legitimate - someone can be out of frame, behind another person, or cut off
    // at the edge - and a close-up naming two people rightly shows one.
    {
      const want = (Array.isArray(s.characters) ? s.characters : []).filter((n) => castById[String(n).toUpperCase()]).length;
      const look = await lookAt(s.first_frame_path);
      const got = look && Array.isArray(look.people) ? look.people.length : null;
      if (want > 0 && got != null && got > want) {
        findings.push({
          shot: s.position,
          state: 'redo_frame',
          on: s.id,
          constraint: `Exactly ${want} ${want === 1 ? 'person' : 'people'} in this shot. Do not duplicate anyone, and add nobody who is not named.`,
          note: `Shot ${s.position}: ${got} people in the frame but ${want} in the shot - someone is doubled or an extra has been invented.`
        });
      }
    }

    // THIS SHOT'S OWN WORDING. Not the notes, not the assembled prompt.
    //
    // Two ways that went wrong, and both cost re-renders of frames that were
    // already right:
    //
    // The notes carry the spoken line, so a close-up of BROWN's face while he
    // says the word "a vehicle" counted as the car being named in the shot.
    //
    // And the assembled prompt carries the SCENE's staging and light, repeated
    // on every shot of that scene by design (5.14). One film's staging read "the
    // a vehicle is centered, the characters always in front of it" - so every
    // prompt in the scene contained the word, including a close-up of the dog,
    // and ten frames were failed for not showing a car nobody had asked them to
    // show. Staging says where things stand when they are present; it is not a
    // list of what each frame contains.
    //
    // raw_frame is what the shot itself is about, which is the question.
    const said = String(s.raw_frame || s.frame_prompt || '').toLowerCase();
    const wanted = [];
    for (const p of propList) {
      if (!p.look) continue;
      if (p.names.some((nme) => said.includes(nme))) wanted.push({ label: p.canonical, description: p.look });
    }
    // Checked against what the PROMPT asked for, not against the character's
    // default description.
    //
    // This used to read visual_anchor straight off the characters table, which is
    // what they wear when nobody has dressed them. So a shot where a character had been
    // deliberately put in a puffer vest was checked against "denim shirt", came
    // back match:false, and was flagged - 29 of 37 shots failed for wearing
    // exactly what we asked them to wear. Worse, the repair constraint was
    // written from the same words: "a character is: ...denim shirt... Match it
    // exactly", appended last where it beats everything before it. One pass of
    // Redo-until-clean would have undressed the entire film.
    const wearing = costumesFor(s, all);
    for (const nme of Array.isArray(s.characters) ? s.characters : []) {
      const n = String(nme).toUpperCase();
      const c = castById[n];
      if (!c) continue;
      // TWO QUESTIONS, not one blended one.
      //
      // This used to merge the costume into the person's description and ask a
      // single question about the result - is this a character - so the answer had to
      // weigh a face, a build, hair and an outfit together and came back as one
      // yes or no. Clothes lost that argument every time: a recognisable person
      // in the wrong jacket reads as a match.
      //
      // A wardrobe item exists in its own right, with its own description and its
      // own reference sheet. So it is asked about on its own terms - does what
      // they are wearing match THIS outfit - and the person is asked about
      // separately, on theirs.
      const outfit = wearing[n];

      // The person: who they are. Clothing clauses are dropped when an outfit was
      // chosen, or this question would fail for the very reason the other one
      // exists - the anchor describes what they wore before they were dressed.
      const feats = tidy0(c.visual_anchor)
        .split(',')
        .map((x) => x.trim())
        .filter(Boolean);
      const who = outfit ? feats.filter((f) => !WEARS.test(f)) : feats;
      const look = who.join(', ') || tidy0(c.visual_anchor);
      if (look) wanted.push({ label: String(nme), description: look });

      // The outfit: strictly, because it was chosen rather than observed. A
      // render that ignored it has failed at the one thing that was asked for.
      if (outfit) {
        wanted.push({
          label: `the clothes ${n} is wearing`,
          description: outfit,
          strict: true
        });
      }
    }
    for (const w of wanted) {
      const v = await matches(s.first_frame_path, w.label, w.description, w.strict);
      if (!v) continue;
      if (v.present === false) {
        findings.push({
          shot: s.position,
          state: 'redo_frame',
          on: s.id,
          constraint: `${w.label} must be visible: ${w.description}.`,
          note: `Shot ${s.position}: ${w.label} is named in the shot but is not in the frame.`
        });
      } else if (v.match === false) {
        findings.push({
          shot: s.position,
          state: 'redo_frame',
          on: s.id,
          constraint: `${w.label} is: ${w.description}. Match it exactly.`,
          note: `Shot ${s.position}: ${w.label} does not match its reference - the frame shows ${String(v.seen || 'something else').slice(0, 80)}.`
        });
      }
    }
  }

  for (let i = 1; i < shotsToCheck.length; i++) {
    const a = shotsToCheck[i - 1];
    const b = shotsToCheck[i];
    if (a.scene_number !== b.scene_number) continue;

    // A missing move needs SOMEONE WHO IS IN BOTH SHOTS.
    //
    // Both checks below ask "was anybody still in the first frame and already
    // moved in the second" - and neither asked whether it was the same person.
    // So a plain cut from BROWN's face to a character raising his camera counted as a
    // move that was never seen, and the pass demanded a shot be inserted to cover
    // a journey nobody had made. Cutting to someone else is not a continuity
    // break; it is a cut.
    const castA = new Set((Array.isArray(a.characters) ? a.characters : []).map((n) => String(n).toUpperCase()));
    const shared = (Array.isArray(b.characters) ? b.characters : [])
      .map((n) => String(n).toUpperCase())
      .filter((n) => castA.has(n));

    // TEXT reading first - it needs no GPU and no vision call, and when it
    // already says a move is missing there is nothing a picture can add.
    const ta = textOf(a);
    const tb = textOf(b);
    const textJumps = shared.length > 0 && STATIC2.test(ta) && MOVED2.test(tb) && !MOVED2.test(ta);
    if (textJumps) {
      findings.push({
        pair: [a.position, b.position],
        state: 'needs_shot',
        on: b.id,
        // On a needs_shot this field holds the PROPOSED ACTION for the shot that
        // goes between, not a correction to append to a prompt. Nothing confuses
        // the two: every reader of this column branches on review_state first,
        // and the re-render path refuses needs_shot outright.
        constraint: await bridgeAction(a, b),
        note: `Shot ${a.position} leaves them in place and shot ${b.position} has them already moved. The move is never seen - a shot belongs between them.`
      });
      continue;
    }

    if (!a.first_frame_path || !b.first_frame_path) continue;
    const la = await lookAt(a.first_frame_path);
    const lb = await lookAt(b.first_frame_path);
    if (!la || !lb) {
      findings.push({
        pair: [a.position, b.position],
        state: 'unresolved',
        on: b.id,
        note: `Could not read ${!la ? 'shot ' + a.position : 'shot ' + b.position}'s frame, so the pair was not compared.`
      });
      continue;
    }

    // PICTURE reading. Only things named in BOTH frames are comparable - an
    // object that left the frame is a cut, not an error.
    const objA = new Map((la.objects || []).map((o) => [String(o.what || '').toLowerCase(), side(o.where)]));
    const objB = new Map((lb.objects || []).map((o) => [String(o.what || '').toLowerCase(), side(o.where)]));
    const flipped = [];
    for (const [what, whereA] of objA) {
      const whereB = objB.get(what);
      if (!whereA || !whereB) continue;
      if ((whereA === 'left' && whereB === 'right') || (whereA === 'right' && whereB === 'left')) flipped.push(what);
    }

    // Which side is wrong? The one whose PICTURE argues with its own TEXT.
    // Whichever frame mentions the flipped thing in words is the one telling the
    // truth; the other is the one to re-render.
    if (flipped.length) {
      const named = flipped[0];
      const inTextA = ta.toLowerCase().includes(named);
      const inTextB = tb.toLowerCase().includes(named);
      const fixB = inTextA || !inTextB;
      findings.push({
        pair: [a.position, b.position],
        state: fixB ? 'redo_next' : 'redo_prev',
        on: fixB ? b.id : a.id,
        constraint: `Keep ${named} ${fixB ? objA.get(named) : objB.get(named)} of frame, as in shot ${fixB ? a.position : b.position}.`,
        note: `"${named}" is screen-${objA.get(named)} in shot ${a.position} and screen-${objB.get(named)} in shot ${b.position}. Re-render shot ${fixB ? b.position : a.position}.`
      });
      continue;
    }

    // Someone in place in one picture and already moved in the next, with
    // nothing between - the same break as the text check, caught in the frames
    // when the words were too vague to show it.
    const movedA = (la.people || []).some(doingMoved);
    const movedB = (lb.people || []).some(doingMoved);
    if (shared.length && !movedA && movedB && (la.people || []).length && (lb.people || []).length) {
      findings.push({
        pair: [a.position, b.position],
        state: 'needs_shot',
        on: b.id,
        // The proposed action for the shot that goes between - see above.
        constraint: await bridgeAction(a, b),
        note: `Shot ${a.position} shows them in place and shot ${b.position} shows them already moved, and the prompts do not cover the move.`
      });
    }
  }

  // Record the verdict on the shot it applies to, so the panel can show it and
  // so a repair knows what to do. Cleared first, otherwise a fixed shot keeps
  // yesterday's complaint.
  for (const s of shotsToCheck) {
    await axios.patch(
      `${insforgeUrl}/api/database/records/director_shots`,
      { review_state: 'ok', review_note: null, review_constraint: null },
      { params: { id: `eq.${s.id}` }, headers: jsonHeaders, validateStatus: () => true }
    );
  }
  for (const f of findings) {
    await axios.patch(
      `${insforgeUrl}/api/database/records/director_shots`,
      { review_state: f.state, review_note: f.note, review_constraint: f.constraint || null },
      { params: { id: `eq.${f.on}` }, headers: jsonHeaders, validateStatus: () => true }
    );
  }

  return {
    action: 'reviewed',
    checked: shotsToCheck.length,
    pairs: Math.max(0, shotsToCheck.length - 1),
    framesRead: [...seen.keys()].length,
    findings,
    clean: findings.length === 0,
    note: findings.length
      ? `${findings.length} pair(s) need attention. redo_prev / redo_next re-render one frame; needs_shot wants a shot inserted between.`
      : 'Every neighbouring pair agrees, in text and in picture.'
  };
}

// ============================================================== plan mode
if (!parsed.planId) return { error: 'Pick or make a plan first - the shot list is written to a plan.' };
const plan = (await records('director_plans', { id: `eq.${parsed.planId}`, select: 'id,movie_id,target_seconds,status' }))[0];
if (!plan || plan.movie_id !== movie.id) return { error: 'That plan does not belong to this movie.' };
if (beats.length === 0) return { error: `${movie.title} has no beats yet - run the Beat Generator first.` };
if (characters.length === 0) return { error: `${movie.title} has no characters yet.` };

// A plan whose shots already have frames or clips is never overwritten - that
// is real GPU work. Make a new plan instead.
const inserting = mode === 'insert';
const existing = await records('director_shots', { plan_id: `eq.${plan.id}`, select: 'id,position,first_frame_path,clip_id' });
// The guard protects a REDRAFT, which deletes every shot and writes new ones.
// An insert adds one shot beside work that already exists, which is the entire
// reason for having it.
if (!inserting && existing.some((s) => s.first_frame_path || s.clip_id)) {
  return { error: 'This plan already has frames or clips. Make a new plan to redraft - this one is kept as it is.' };
}

const SYSTEM = [
  'You are a film director planning the shot list for a short film. Reply with JSON only.',
  `Cover this script. Plan about ${coverageShots} shots - never more than ${coverageShots}.`,
  `That is ${lines.length} carrying a line, about ${requiredReactions} reactions the rules require, ${requiredEstablishing} establishing shots, ${requiredMasters} masters showing where people stand, and at most ${actionShots} more for action, inserts and cutaways - one per beat at most.`,
  'There is no runtime to reach. The film is as long as covering the script makes it. If a beat has nothing happening in it, do not invent a shot for it.',
  'Rules:',
  '- Every dialogue line gets its own shot with the speaker on screen. Use each line id exactly once. A shot carries at most one line.',
  '- After a line, the next shot is a reaction shot of someone else present in the scene (type "reaction", no line), unless the next shot is another character answering with their own line.',
  '- A "reaction" shot NEVER carries a line and NEVER shows the person who just spoke - it shows someone else listening. A shot that carries a line is "close" or "medium", never "reaction".',
  '- Share the remaining shots by how much happens in a beat, not evenly. Action and big moments get extra shots.',
  '- The scenes listed in needs_establishing must open with a shot of type "establishing". No other scene gets one.',
  '- Coverage: medium and close shots for dialogue; reaction shots as above; insert shots for key objects; wide shots for action.',
  '- continuity: "continue" means there is NO CUT. The shot carries straight on from the one before it, same camera, and the two play as ONE continuous take. Use it where the action genuinely runs on past a single shot: a fight carrying on, a fall, a beam firing, a beast collapsing. Mark it on the SECOND of the two shots.',
  '- Expect none to two "continue" shots in a whole film, and none at all in a talking scene. If in doubt, "fresh".',
  '- Everything else is "fresh": every new angle, every reaction, every establishing shot, and the first shot of every scene.',
  '- At most four characters on screen. If all five are needed, frame them from behind.',
  '- characters: list every person visible in the shot, by NAME. Never write "the five", "the group" or "everyone" in frame or action - name them, and list every one of them in characters.',
  `- type is one of: ${TYPES.join(', ')}. That is what the shot is FOR.`,
  `- size is one of: ${SIZES.join(', ')}. That is how close the camera is, asked separately: a reaction can be a medium_close or a close, an establishing shot is wide or full.`,
  '- Never give two shots in a row the same size on the same person. Step it - wide, then medium, then close. Two matching framings back to back read as a mistake, not a cut.',
  '- Open a scene that has more than one person with a wide or full shot that shows where everyone is standing, before any closer shot. Without it nobody knows the room.',
  '- foreground: ONE thing already in the scene that sits close to the camera with the subject behind it - a railing, a doorway edge, a shoulder, leaves. Three or four words. This is what gives a frame depth. Leave it null only for an insert.',
  '- scene_look gives each scene its sides ("the city is screen-left"), its light, and its staging - where the fixed things stand relative to each other. Keep the camera on ONE side of a conversation for the whole scene: if a character is looking screen-right in one shot they look screen-right in every shot of that exchange, or they appear to swap places. Obey the staging: if it says the car is parked screen-left of the door, it is screen-left in every shot. Do not write the light or the staging into frame - both are added for you.',
  // 5.15 - continuity of action. A cut may skip TIME but not a MOVE: if someone
  // is standing beside a car in one shot and behind the wheel in the next, the
  // getting-in has to be seen, or the cut reads as a mistake. This is the single
  // most common break and it costs nothing to avoid at planning time.
  '- Continuity of action: consecutive shots in a scene must be reachable from one another. If a character changes place, posture or what they are holding between two shots, a shot covering that move goes BETWEEN them. Do not jump a person from standing beside something to operating it.',
  '- If a beat describes a move (someone arrives, gets in, picks something up, crosses to another person), that move gets its own shot. It is not enough for the shot after it to show the result.',
  '- Every shot without a line runs the same 5.2 seconds. Do not ask for longer shots and do not try to reach a runtime.',
  '- scene_looks: for EVERY scene, one short look under 20 words - the place, the time of day, the light (e.g. "school rooftop at sunset, golden light, drifting cherry blossom petals"). It is repeated on every shot of that scene, so keep it to what never changes.',
  '- from_behind: for EVERY character, their hair and outfit in under 12 words, as seen from behind (no face, eyes or expression).',
  '- subjects: for EVERY thing that is NOT one of the characters and appears in more than one shot - a creature, a vehicle, a key object - one short look under 20 words, in the script\'s own words. Call it by the same name in every frame and action ("the beast", not "the creature" then "the monster").',
  '- frame: the first frame only - who is where and doing what, and the framing. Under 40 words, plain words from the script. Refer to characters by their NAME. Do not repeat the scene look. No camera movement words.',
  '- action: what happens during the shot, one or two short sentences, script wording. Do not describe anyone speaking - the line is added separately. Never mention the camera ("the camera holds on...", "the camera pans over...") - write what happens in the frame.',
  '- sound: the concrete sounds of the shot in lower case (e.g. "a soft evening breeze and a distant city hum"), no speech.',
  'Output: {"scene_looks":{"1":"..."},"from_behind":{"NAME":"..."},"subjects":{"the beast":"..."},"shots":[{"scene":1,"beat":"A1S1B1","type":"establishing","size":"wide","foreground":"the metal railing","characters":["NAME"],"continuity":"fresh","frame":"...","action":"...","line":null or "A1S1B1#1","sound":"..."}]}'
].join('\n');

const brief = {
  film: movie.title,
  style: styleKey,
  needs_establishing: [...needsEstablishing],
  // Per scene, typed once in the Director tab: which way things lie on screen,
  // and where the light comes from. Both are held for every shot of the scene.
  scene_look: Object.fromEntries(
    sceneList.map((n) => [
      n,
      {
        screen_direction: (sceneByNum[n] || {}).screen_direction || '',
        key_light: (sceneByNum[n] || {}).key_light || '',
        staging: (sceneByNum[n] || {}).staging || ''
      }
    ])
  ),
  characters: characters.map((c) => ({ name: String(c.name).toUpperCase(), look: c.visual_anchor || '' })),
  // So the model calls a prop the same thing every time. It cannot hold one
  // still, but it can stop renaming it - "the beast" then "the creature" is what
  // makes a look impossible to attach.
  props: propRows.map((p) => ({
    name: p.name,
    kind: p.kind,
    look: p.description || '',
    also_called: Array.isArray(p.aliases) ? p.aliases : []
  })),
  scenes: sceneList.map((n) => {
    const s = sceneByNum[n] || {};
    const w = where(n);
    const bs = beats.filter((b) => b.scene_number === n);
    return {
      scene: n,
      location: w.location,
      time_of_day: w.time,
      place: s.location_description || '',
      sound_ambience: s.sound_ambience || '',
      present: [...(present[n] || [])],
      beats: bs.map((b) => ({
        beat: b.beat_code,
        summary: b.summary || '',
        action: b.action_text || '',
        lines: lines.filter((l) => l.beat === b.beat_code).map((l) => ({ id: l.id, speaker: l.character, text: l.text }))
      }))
    };
  })
};

async function askModel(extra) {
  const r = await llmChat(
    {
      model: ollamaModel,
      stream: false,
      think: false,
      format: 'json',
      options: { temperature: 0.5, num_ctx: 16384 },
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: JSON.stringify(brief) + (extra ? '\n\n' + extra : '') }
      ]
    },
    { timeout: 600000 }
  );
  const raw = (r.data && r.data.message && r.data.message.content) || '';
  const out = JSON.parse(raw);
  const looks = {};
  for (const [k, v] of Object.entries(out.scene_looks || {})) if (String(v || '').trim()) looks[Number(k)] = String(v).trim();
  const fromBehind = {};
  for (const [k, v] of Object.entries(out.from_behind || {})) if (String(v || '').trim()) fromBehind[String(k).toUpperCase()] = String(v).trim();
  // 5.5b - a creature or object has no reference image, so its look is written
  // once here and repeated word for word wherever it appears.
  const subjects = {};
  for (const [k, v] of Object.entries(out.subjects || {})) {
    const key = String(k || '').trim();
    if (key && String(v || '').trim()) subjects[key.toLowerCase()] = String(v).trim();
  }
  return { shots: Array.isArray(out.shots) ? out.shots : [], looks, fromBehind, subjects };
}

// ------------------------------------------------------------ the rules
function problems(res) {
  const shots = res.shots;
  const p = [];
  const used = {};
  shots.forEach((s, i) => {
    if (s.line) {
      if (!lineById[s.line]) p.push(`shot ${i + 1}: unknown line id "${s.line}"`);
      used[s.line] = (used[s.line] || 0) + 1;
    }
  });
  for (const l of lines) {
    if (!used[l.id]) p.push(`line ${l.id} (${l.character}: "${l.text}") has no shot`);
    else if (used[l.id] > 1) p.push(`line ${l.id} is used ${used[l.id]} times - use it once`);
  }
  // 5.3 reactions
  shots.forEach((s, i) => {
    const l = s.line && lineById[s.line];
    if (!l) return;
    const scene = Number(s.scene) || l.scene;
    const who = others(scene, l.character);
    if (!who.length) return;
    // A reaction only counts when it is silent and shows someone other than
    // the speaker - otherwise "reaction" is just a label on the next line.
    const next = shots[i + 1];
    const nl = next && next.line && lineById[next.line];
    const sameScene = next && (Number(next.scene) || scene) === scene;
    const nextNames = next ? (Array.isArray(next.characters) ? next.characters : []).map((n) => String(n).toUpperCase()) : [];
    const isReaction = sameScene && next.type === 'reaction' && !next.line && nextNames.some((n) => n !== l.character);
    const isAnswer = sameScene && nl && nl.character !== l.character;
    if (!(isReaction || isAnswer)) p.push(`after line ${l.id} (${l.character}) add a silent reaction shot of ${who.join(' or ')} - not ${l.character}, and with no line of its own`);
  });
  shots.forEach((s, i) => {
    if (s.type === 'reaction' && s.line) p.push(`shot ${i + 1}: a reaction shot carries no line - use "close" or "medium" for the line`);
  });
  // 5.3 establishing
  const first = {};
  shots.forEach((s) => {
    const n = Number(s.scene);
    if (!(n in first)) first[n] = s;
  });
  for (const n of needsEstablishing) {
    if (first[n] && first[n].type !== 'establishing') p.push(`scene ${n} changes location or time of day - open it with an establishing shot`);
  }
  // 5.5 - everyone the text puts on screen is listed
  shots.forEach((s, i) => {
    const text = `${s.frame || ''} ${s.action || ''}`;
    const listed = new Set((Array.isArray(s.characters) ? s.characters : []).map((n) => String(n).toUpperCase()));
    const missing = namesIn(text).filter((n) => !listed.has(n));
    if (missing.length) p.push(`shot ${i + 1}: ${missing.join(', ')} appear in the frame but are not in characters - list everyone visible`);
    if (!listed.size && GROUP_WORDS.test(text)) p.push(`shot ${i + 1}: the frame says "${(text.match(GROUP_WORDS) || [])[0]}" but characters is empty - name them and list them`);
  });
  // 5.4 scene looks, 5.5 from-behind descriptions
  for (const n of sceneList) if (!res.looks[n]) p.push(`scene_looks is missing scene ${n}`);
  if (shots.some((s) => (s.characters || []).length > 4)) {
    for (const c of charNames) if (!res.fromBehind[c]) p.push(`from_behind is missing ${c}`);
  }
  // 5.12 - two shots in a row at the same size on the same person read as a
  // mistake rather than a cut. Films step the size instead: wide, then medium,
  // then close. Checked here rather than fixed silently, because the repair is
  // to reframe the shot, which only the model can do.
  for (let i = 1; i < shots.length; i++) {
    const a = shots[i - 1];
    const b = shots[i];
    if (a.scene !== b.scene) continue;
    const sizeA = SIZES.includes(a.size) ? a.size : sizeFor(a.type);
    const sizeB = SIZES.includes(b.size) ? b.size : sizeFor(b.type);
    if (sizeA !== sizeB) continue;
    const who = (x) => (Array.isArray(x.characters) ? x.characters : []).map((v) => String(v).toUpperCase()).sort().join(',');
    if (who(a) && who(a) === who(b)) {
      p.push(`shots ${i} and ${i + 1} are both "${sizeA}" on the same person - step the size between them (wide, then medium, then close)`);
    }
  }

  // 5.12 - the master. A scene with more than one person opens on a shot that
  // shows where they are standing; without it the audience never gets the room,
  // only faces. "establishing" is the LOCATION, which is not the same thing.
  for (const sn of sceneList) {
    const inScene = shots.filter((x) => x.scene === sn);
    if (!inScene.length) continue;
    const peopled = inScene.some((x) => (x.characters || []).length > 1);
    if (!peopled) continue;
    const firstPeopled = inScene.find((x) => (x.characters || []).length > 1);
    const before = inScene.slice(0, inScene.indexOf(firstPeopled) + 1);
    const hasMaster = before.some((x) => {
      const sz = SIZES.includes(x.size) ? x.size : sizeFor(x.type);
      return (sz === 'wide' || sz === 'full') && (x.characters || []).length > 1;
    });
    if (!hasMaster) {
      p.push(`scene ${sn} has more than one person on screen but never shows where they are standing - open it with a "wide" or "full" shot with everyone in it, before any closer shot`);
    }
  }

  // 5.15 - continuity of action, checked from the text alone.
  //
  // A cut may skip time but not a move. Seen in a real render: a character standing at
  // the bumper, then a character behind the wheel, with nothing between - the getting
  // in never happened on screen, so the cut reads as a mistake rather than a
  // cut. Cheap to catch here, because it needs no pictures: the same person, in
  // the same scene, in two neighbouring shots, where one describes them in a
  // POSITION and the next describes them OPERATING or somewhere else.
  //
  // Deliberately a small vocabulary rather than an LLM judgement - a short list
  // of verbs that mean "already moved" catches the common case and never fires
  // on a reaction shot, and a checker that cries wolf gets ignored.
  const MOVED = /\b(?:behind the wheel|at the wheel|inside|in the driver|seated|sitting in|sits in|holding|carrying|wearing|driving|riding|on board|aboard)\b/i;
  const STATIC = /\b(?:stands?|standing|waits?|waiting|beside|next to|in front of|outside|watches?|watching|looks? at)\b/i;
  for (let i = 1; i < shots.length; i++) {
    const a = shots[i - 1];
    const b = shots[i];
    if (a.scene !== b.scene) continue;
    const who = (x) => new Set((Array.isArray(x.characters) ? x.characters : []).map((v) => String(v).toUpperCase()));
    const shared = [...who(a)].filter((n) => who(b).has(n));
    if (!shared.length) continue;
    const textA = `${a.frame || ''} ${a.action || ''}`;
    const textB = `${b.frame || ''} ${b.action || ''}`;
    if (STATIC.test(textA) && MOVED.test(textB) && !MOVED.test(textA)) {
      p.push(
        `shots ${i} and ${i + 1}: ${shared.join(', ')} goes from where shot ${i} leaves them to somewhere else in shot ${i + 1} with nothing covering the move - add a shot between them that shows it`
      );
    }
  }

  // 5.9 - coverage, not runtime. Too many shots is padding; the shots the rules
  // require are checked above and cannot go missing, so there is no lower bound
  // to police here and nothing to gain by making the list longer.
  if (shots.length > coverageShots) {
    p.push(`you planned ${shots.length} shots - at most ${coverageShots} cover this script. Remove the ones that do not cover anything.`);
  }
  return p;
}

// 5.17 - the shimmy. One shot, written by hand, put in at a chosen position.
//
// It runs through the SAME builder as a planned shot rather than down a second
// path of its own: character anchors bound at first mention, props bound by name
// and every alias, the camera line derived from size and foreground, the scene's
// light, staging and sound bed, the continuation mode. A separate builder for
// hand-made shots would drift from this one inside a week, and the inserted shot
// is precisely the one that must not look different from its neighbours.
//
// So the model is skipped and its output is forged instead: one shot in the
// shape askModel returns. `looks` is left empty deliberately - lookOf() already
// falls back to the scene's own prose, which is what this shot should carry.
let best;
let issues = [];
let rounds = 0;
if (inserting) {
  const sceneOf =
    Number(parsed.scene) ||
    (existing.find((x) => x.position === Math.round(Number(parsed.position) || 0)) || {}).scene_number ||
    1;
  const who = (Array.isArray(parsed.characters) ? parsed.characters : [])
    .map((x) => String(x).toUpperCase())
    .filter((x) => charNames.has(x));
  if (!String(parsed.action || '').trim()) {
    return { error: 'Say what happens in the shot - that is what the prompt is written from.' };
  }
  best = {
    shots: [
      {
        scene: sceneOf,
        beat: parsed.beat || null,
        type: String(parsed.type || 'medium'),
        size: String(parsed.size || ''),
        foreground: nothing(parsed.foreground) ? null : String(parsed.foreground),
        characters: who,
        continuity: parsed.continuity === 'continue' ? 'continue' : 'fresh',
        // One sentence does both jobs unless they are given separately: what the
        // first frame shows, and what happens during the shot.
        frame: String(parsed.frame || parsed.action).trim(),
        action: String(parsed.action).trim(),
        line: null,
        sound: (sceneByNum[sceneOf] || {}).sound_ambience || 'a soft breeze'
      }
    ],
    looks: {},
    fromBehind: {},
    subjects: {}
  };
} else {
  best = await askModel('');
  issues = problems(best);
  while (issues.length && rounds < 2) {
    rounds++;
    const next = await askModel('Your previous list broke these rules - fix them and return the whole JSON again:\n- ' + issues.join('\n- '));
    const nextIssues = problems(next);
    if (nextIssues.length <= issues.length) {
      best = next;
      issues = nextIssues;
    }
  }
}
let shots = best.shots;
const looks = best.looks;
const fromBehind = best.fromBehind;
const subjects = best.subjects || {};
const fixes = [];

// EVERY RECURRING OBJECT BECOMES A PROP, so it can be given a reference.
//
// The planner is asked, in as many words, to list every thing that is not a
// character and appears in more than one shot - a vehicle, a creature, a key
// object. It then pastes that description into every prompt the thing appears
// in, and throws the list away.
//
// So the pipeline knew an object recurred, described it dozens of times, and
// never once offered to anchor it. Words alone do not hold an object still: the
// same detailed description rendered a different vehicle in every shot, because
// a description is a suggestion and a reference picture is not. The operator had
// no way to know a sheet was missing, because nothing ever said the object
// existed.
//
// Written as drafts with no image, so they appear in Props & Wardrobe as things
// waiting for a sheet. Nothing is rendered here and nothing is overwritten - a
// prop that already exists under that name is left exactly as it is.
const newSubjects = [];
{
  const already = new Set();
  for (const p of propRows) {
    already.add(subjectKey(p.name));
    for (const a of Array.isArray(p.aliases) ? p.aliases : []) already.add(subjectKey(a));
  }
  for (const [key, look] of Object.entries(subjects)) {
    if (already.has(subjectKey(key))) continue;
    already.add(subjectKey(key));
    newSubjects.push({
      movie_id: movie.id,
      name: key,
      kind: 'prop',
      description: look,
      render_style: styleKey,
      notes: 'Proposed by the Director: appears in more than one shot. Render a sheet so it stops changing.'
    });
  }
  if (newSubjects.length) {
    const r = await axios.post(`${insforgeUrl}/api/database/records/movie_props`, newSubjects, {
      headers: jsonHeaders,
      validateStatus: () => true
    });
    if (r.status >= 200 && r.status < 300) {
      fixes.push(
        `${newSubjects.length} recurring object(s) added to Props & Wardrobe with no sheet yet: ${newSubjects
          .map((p) => p.name)
          .join(', ')}. Render their sheets or they will look different in every shot.`
      );
    } else {
      // Not fatal - the plan is still worth having - but said, because a silent
      // failure here is exactly how the objects went missing in the first place.
      fixes.push(`recurring objects could not be added to Props & Wardrobe (HTTP ${r.status})`);
    }
  }
}

// ---------------------------------------------- deterministic fall-backs
//
// These complete a WHOLE plan: every line gets a shot, every listener gets a
// reaction, every new place gets an establishing shot. Run against one
// hand-made shot they do not repair it, they bury it - the first insert put in
// one shot and the fall-backs added thirty-five more around it, so built[0] was
// an establishing shot the operator never asked for. An inserted shot is one
// shot, exactly as written.
const repair = !inserting;

// Duplicate lines: the first shot keeps it, later ones become silent.
const seen = new Set();
for (const s of shots) {
  if (s.line && lineById[s.line]) {
    if (seen.has(s.line)) {
      fixes.push(`line ${s.line} appeared twice - kept the first`);
      s.line = null;
    } else seen.add(s.line);
  } else if (s.line) {
    fixes.push(`dropped unknown line id ${s.line}`);
    s.line = null;
  }
}
const lookOf = (n) => looks[n] || `${where(n).location} ${where(n).time ? 'at ' + String(where(n).time).toLowerCase() : ''}`.trim();
// Missing lines: a close shot of the speaker after the last shot of that beat.
for (const l of repair ? lines : []) {
  if (seen.has(l.id)) continue;
  let at = -1;
  shots.forEach((s, i) => { if (s.beat === l.beat || (at === -1 && Number(s.scene) === l.scene)) at = i; });
  shots.splice(at + 1, 0, {
    scene: l.scene, beat: l.beat, type: 'close', size: 'close', characters: [l.character], continuity: 'fresh',
    frame: `${l.character} in close-up`, action: `${l.character} looks up`, line: l.id,
    sound: (sceneByNum[l.scene] || {}).sound_ambience || 'a soft breeze'
  });
  seen.add(l.id);
  fixes.push(`line ${l.id} had no shot - added a close shot of ${l.character}`);
}
// A shot that carries a line is never a reaction shot, whatever the model
// called it - that label was being used to dodge the rule.
for (const s of shots) {
  if (s.line && s.type === 'reaction') {
    s.type = 'close';
    fixes.push(`a reaction shot carried line ${s.line} - made it a close shot`);
  }
}
// Missing reactions: a silent close-up of someone listening.
for (let i = 0; repair && i < shots.length; i++) {
  const s = shots[i];
  const l = s.line && lineById[s.line];
  if (!l) continue;
  const scene = Number(s.scene) || l.scene;
  const who = others(scene, l.character);
  if (!who.length) continue;
  const next = shots[i + 1];
  const nl = next && next.line && lineById[next.line];
  const sameScene = next && (Number(next.scene) || scene) === scene;
  const nextNames = next ? (Array.isArray(next.characters) ? next.characters : []).map((n) => String(n).toUpperCase()) : [];
  const isReaction = sameScene && next.type === 'reaction' && !next.line && nextNames.some((n) => n !== l.character);
  const isAnswer = sameScene && nl && nl.character !== l.character;
  if (isReaction || isAnswer) continue;
  const listener = who[0];
  shots.splice(i + 1, 0, {
    scene, beat: l.beat, type: 'reaction', size: 'medium_close', characters: [listener], continuity: 'fresh',
    // Not "listening to CHIBI" - naming the speaker here put her on her own
    // reaction shot once the frame text started deciding who is on screen.
    frame: `${listener} listening`, action: `${listener} reacts`, line: null,
    sound: (sceneByNum[scene] || {}).sound_ambience || 'a soft breeze', seconds: 5
  });
  fixes.push(`added a reaction shot of ${listener} after ${l.id}`);
  i++;
}
// Missing establishing shots: relabel a silent wide opener, else insert one.
for (const n of repair ? needsEstablishing : []) {
  const i = shots.findIndex((s) => Number(s.scene) === n);
  if (i === -1 || shots[i].type === 'establishing') continue;
  if (!shots[i].line && shots[i].type === 'wide') {
    shots[i].type = 'establishing';
    fixes.push(`scene ${n}: the opening wide shot now counts as its establishing shot`);
  } else {
    shots.splice(i, 0, {
      scene: n, beat: null, type: 'establishing', size: 'wide', characters: [], continuity: 'fresh',
      frame: 'wide view of the whole place', action: `The ${where(n).location} ${where(n).time ? 'at ' + String(where(n).time).toLowerCase() : ''}`.trim(),
      line: null, sound: (sceneByNum[n] || {}).sound_ambience || 'a soft breeze', seconds: 6
    });
    fixes.push(`scene ${n}: added an establishing shot`);
  }
}
for (const n of sceneList) if (!looks[n]) fixes.push(`scene ${n}: no look from the model - used "${lookOf(n)}"`);

// ------------------------------------------------------- build each shot
function pad(sec) {
  const ms = Math.round(sec * 1000);
  const s = Math.floor(ms / 1000), m = Math.floor(s / 60);
  return `${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}.${String(ms % 1000).padStart(3, '0')}`;
};
// 5.6 - a sound description sits mid-sentence, so it starts in lower case
// ("The only sounds are a loud boom"), unless it opens with an acronym.
function lower(t) { return t && /^[A-Z][a-z ]/.test(t) ? t[0].toLowerCase() + t.slice(1) : t; }
// 5.6 - no camera-move words. They overshoot: a "push in" turned the vault shot
// into an extreme close-up of garbled dials. The model writes them anyway
// ("The camera holds on the rooftop"), so they are stripped -> "The rooftop".
function noCamera(t) {
  let out = String(t || '')
    // The trailing clause goes first, whole ("..., as the camera tracks him").
    // The other way round the phrase strip eats "the camera tracks" and leaves
    // "Red lunges forward, as him".
    .replace(/\s*[,;]?\s*(?:as|while)\s+the camera\b[^.,;]*/gi, '')
    .replace(/\bthe camera\s+(?:slowly\s+|quickly\s+)?(?:holds? on|holds|pans?(?:\s+(?:over|across|to|left|right|up|down))?|zooms?(?:\s+(?:in|out))?(?:\s+on)?|pushes? in(?:\s+on)?|pulls?\s+(?:out|back)|tracks?|follows?|tilts?(?:\s+(?:up|down))?(?:\s+to)?|drifts?|glides?|cuts? to)\s*/gi, '')
    .replace(/\s+([,.;])/g, '$1')
    .replace(/\s{2,}/g, ' ')
    .trim()
    .replace(/^[,;:\-\s]+/, '');
  if (out && /^[a-z]/.test(out)) out = out[0].toUpperCase() + out.slice(1);
  return out;
};
function shortLook(n) { return anchorText(n).split(/\s+/).slice(0, 12).join(' '); }
// "the BOY from the first images" - taken from the anchor's own wording.
// What to call someone before their name - READ, not guessed.
//
// This used to pattern-match the written description: a list of words for
// people, then a longer list for animals, a regex for hair, another for
// garments. Every kind of character the list had not met came out as "the
// character", which is no instruction at all - and a name the renderer
// recognised then decided the picture on its own.
//
// The answer is data now. `kind` is set once when a character is created and
// read here; `gender` gives the word for a person. The description supplies the
// specifics right after, so "the animal from the first image, X, with a small
// fluffy white dog..." names the species without this having to know a single
// species word.
function whoWord(n) {
  const kind = CHAR_KIND[String(n).toUpperCase()] || 'person';
  if (kind !== 'person') return kind;
  const g = CHAR_GENDER[String(n).toUpperCase()];
  if (g === 'male') return 'man';
  if (g === 'female') return 'woman';
  return 'person';
};
function costumeOf(n) {
  const want = String(n).toUpperCase();
  if (shotCostume[want]) return shotCostume[want];
  // The screenplay writes "DR. EMMETT BROWN" where the cast list says "BROWN",
  // so the match is loose in both directions - an exact lookup found nothing.
  for (const k of Object.keys(shotCostume)) {
    if (k.includes(want) || want.includes(k)) return shotCostume[k];
  }
  return '';
};

// The trailing comma on an anchor collides with the model's own punctuation
// when the name ended a sentence: "...bandaged forearms and upper arm,. He
// stands near the door." Drop the comma when a stop follows it.
function tidy(t) {
  return String(t || '')
    .replace(/,\s*,/g, ',')
    .replace(/\s+([,.;])/g, '$1')
    .replace(/,\s*([.;!?])/g, '$1')
    .replace(/[,\s]+$/, '');
}
// Binding a name that opened the sentence leaves it lower case, and the style
// prefix puts a full stop right before it: "...vibrant colors. the boy from the
// first images, BLONDI, ...".
function upFirst(t) { return t && /^[a-z]/.test(t) ? t[0].toUpperCase() + t.slice(1) : t; }
function esc(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
/**
 * 5.5b, the Subject rule. A creature or object is not a character: it has no
 * reference image, so nothing holds it still. Its look is written once and
 * pasted at its first mention in every shot it appears in - the same trick as
 * the scene look (5.4), which is what keeps a location steady across cuts.
 *
 * Starfall's beast was named in five shots and rendered in two, as a brown
 * upright werewolf and then a grey wolf on all fours - the script says "a giant
 * shadow beast" of "black smoke".
 */
// One letter of slack on a long, unusual word.
//
// The model writes a proper noun the way it remembers it, not the way the props
// table spells it: across two Back to the Future plans it wrote "DELORIAN" six
// times against an alias of "the a vehicle", so six shots naming the car had no
// description bound at all - and no alias list can be written to cover
// misspellings that have not happened yet. Edit distance 1, and only on words of
// eight characters or more, so "the car" and "a cat" are never confused with
// each other.
function near(a, b) {
  if (a === b) return true;
  if (a.length < 8 || Math.abs(a.length - b.length) > 1) return false;
  let i = 0, j = 0, slips = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { i++; j++; continue; }
    if (++slips > 1) return false;
    if (a.length > b.length) i++;
    else if (b.length > a.length) j++;
    else { i++; j++; }
  }
  return slips + (a.length - i) + (b.length - j) <= 1;
};

function bindSubject(t, key, look) {
  let done = false;
  const src = String(t || '');
  // Exact first - the common case, and it must never be changed by the fuzzy
  // pass below.
  let text = src.replace(new RegExp(`\\b${esc(key)}\\b`, 'gi'), (m) =>
    done ? m : ((done = true), `${m}, ${look},`)
  );
  // Only if nothing matched exactly, and only for a single-word key: a
  // near-miss on a whole phrase is far more likely to be a different phrase.
  if (!done && !/\s/.test(key) && key.length >= 8) {
    text = src.replace(/\b[A-Za-z][A-Za-z'-]{6,}\b/g, (w) =>
      done || !near(w.toLowerCase(), key.toLowerCase()) ? w : ((done = true), `${w}, ${look},`)
    );
  }
  return { bound: done, text: done ? tidy(text) : src };
};
// "Blondi storms out" -> "the boy from the first images, BLONDI, with spiky
// ash-blond hair, a black tank top and bandaged arms, storms out". Only the
// first mention is bound; the rest stay as the bare name, which is short and by
// then already anchored. The CLOSING comma matters - without it the look runs
// into the verb ("...and upper arm storms out of the door").
function bindName(t, n, slot) {
  let bound = false;
  // Built from nameRe's own source rather than re-typing the word boundaries:
  // written by hand this line read `(\b...` inside a template literal, where
  // \b is the BACKSPACE escape, not a word boundary - so the regex silently
  // matched nothing and every name stopped binding.
  const re = new RegExp('(' + nameRe(n).source + ")(['’]s)?", 'g');
  const text = String(t || '').replace(re, (m, _name, poss) => {
    if (bound) return m;
    // A possessive is left alone. The anchor ends in a comma, so splicing it
    // into "CHIBI's face" gave "...a red plaid skirt,'s face"; carrying the
    // possessive with "whose" fixed the punctuation but not the grammar -
    // "Close up on CHIBI's face." became "...a red plaid skirt, whose face.",
    // a sentence with no verb. An unbound name is not lost: refNote names and
    // describes it in its own sentence afterwards, which reads correctly
    // whatever the model wrote.
    if (poss) return m;
    bound = true;
    return `the ${whoWord(n)} from ${slot}, ${n}, with ${anchorOf(n, costumeOf(n))},`;
  });
  return { bound, text: bound ? upFirst(tidy(text)) : String(t || '') };
};

/**
 * Compose one shot's two prompts, from nothing.
 *
 * A prompt is DERIVED, never edited. It used to be written once at draft time
 * and then patched in place whenever a costume changed - find the old clause,
 * swap in the new one. That is how a prompt ended up carrying the same trench
 * coat six times over: a prompt names a person more than once, the patch could
 * not tell which mention it had already done, and every run added another.
 *
 * So there is no patching anywhere any more. The script's own words are kept on
 * the row (raw_frame, raw_action) and the whole prompt is BUILT AGAIN from
 * today's tables each time something changes. Run it twice and you get the same
 * sentence twice; run it after a costume change and the old clause is simply not
 * there to find, because nothing was carried over.
 *
 * spec: { label, scene, sceneRow, look, type, size, foreground, names, refs?,
 *         fromBehind, subjects, frame, action, line, sound, unnamed, costumes }
 */
function composeShot(spec) {
  // Read by the binders below, which are declarations and cannot see a caller's
  // variables. Only the people in THIS shot are in it, and only the ones with a
  // costume chosen - a shot with just a character in it never hears about BROWN's coat,
  // and a person with nothing chosen keeps their own description untouched.
  shotCostume = spec.costumes || {};
  const notes = [];
  const names = (spec.names || []).slice();
  let frame = anonymise(noCamera(clean(spec.frame)), (spec.unnamed || []));
  let refs = names;
  if (names.length > 4) {
    frame += `. Seen from behind, left to right: ${names.map((n) => `${n} with ${clean((spec.fromBehind || {})[n] || shortLook(n))}`).join('; ')}`;
    refs = [];
    notes.push(`shot ${spec.label}: ${names.length} characters - framed from behind with no references`);
  }
  // 5.5 - bind each name to its reference slot AND a short look, inline at its
  // first mention: "the boy from the first images, BLONDI, with spiky ash-blond
  // hair, a black tank top and bandaged arms". A bare name plus a note at the
  // end leaves the renderer to work out what the name means, and these names are
  // colour words - "Blondi" came back as a blond stranger.
  //
  // ONE picture per person, counted in the order the cast is listed. This read
  // "the first imageS", and called a two-person shot's slots "first" and "last",
  // from when the tab sent two pictures each. It sends one now - cast first, the
  // set plate last - so "the last images" in a two-hander pointed at the plate,
  // and BROWN's description landed on a photograph of a car park. The prompt can
  // count references and nothing else: the labels stored beside them are never
  // sent to the model, so this wording has to match what the tab sends.
  const SLOTS = ['first', 'second', 'third', 'fourth'];
  const slotOf = (i) => `the ${SLOTS[i] || 'next'} image`;
  // Two bindings inline at most. Four of them ran to ninety words and the action
  // drowned: "attacking the beast's arms" sat in the middle of four descriptions
  // and the frame came back with the four of them milling about, no beast. The
  // rest are stated after the sentence instead.
  const unbound = [];
  let inline = 0;
  refs.forEach((n, i) => {
    if (inline >= 2) {
      unbound.push({ n, i });
      return;
    }
    const r = bindName(frame, n, slotOf(i));
    if (r.bound) {
      frame = r.text;
      inline++;
    } else unbound.push({ n, i }); // the model wrote "He steps forward" - say who that is
  });
  // 5.5b - then the things that are not characters.
  // Props first, so an approved sheet's wording wins over anything the model
  // invented for the same object.
  const boundProps = new Set();
  for (const prop of propList) {
    // One description per prop per shot: the first name that matches wins, and
    // the rest are skipped, or a shot saying "the wish star crystal" would be
    // described twice - once for the full phrase and again for "crystal".
    for (const alias of prop.names) {
      const r = bindSubject(frame, alias, prop.look);
      if (r.bound) {
        frame = r.text;
        boundProps.add(prop.canonical.toLowerCase());
        notes.push(`shot ${spec.label}: ${prop.canonical} described from Props & Wardrobe`);
        break;
      }
    }
  }
  for (const [key, look] of Object.entries(spec.subjects || {})) {
    // The table wins over anything the model invented for the same object.
    //
    // This used to compare the subject key against the prop's CANONICAL name
    // only, so a subject keyed by one of its aliases slipped through and both
    // descriptions were pasted into one sentence: "...near the a vehicle,
    // stainless steel car covered in circuit boards, gull-wing doors, glowing
    // internal lights, stainless steel car covered in circuit boards, as long
    // as a standard car". Matched against every name a prop answers to, and
    // against every prop rather than only the ones that bound here - a second
    // description of an object the operator has already approved and rendered a
    // sheet for is never wanted, bound in this shot or not.
    if (propNameSet.has(subjectKey(key))) continue;
    const r = bindSubject(frame, key, look);
    if (r.bound) {
      frame = r.text;
      notes.push(`shot ${spec.label}: ${key} described as written in subjects`);
    }
  }
  // There is no second sentence about clothes. A costume reaches the prompt
  // through the person's own description - anchorOf() REPLACES what they were
  // wearing with it - and it does so whether the name was bound inline or is
  // named in the reference note below. So every costume is already stated, once.
  //
  // There used to be a trailing "a character is wearing ..." on top of that, and it
  // looked up every wardrobe item whose worn_by pointed at the person. worn_by is
  // the costume's default wearer and says nothing about what was picked for THIS
  // shot, so a shot where a character was put in his second outfit got the new one in
  // his description and then, one sentence later, the old one stated more plainly
  // - which is why he kept turning up in the baseball cap. Saying it twice never
  // helped the render even when both copies agreed.

  const refNote = unbound
    .map(({ n, i }) => ` The ${whoWord(n)} from ${slotOf(i)} is ${n}, with ${anchorOf(n, costumeOf(n))}.`)
    .join('');
  // 5.12 - where the camera stands. Until now a frame prompt carried the size
  // and the setting and nothing else, so every shot sat at the same neutral
  // height, flatly lit, and lit differently from its neighbour. These are the
  // things a still-image prompt CAN say: camera words are stripped out of the
  // motion prompt because the video model mangles them (5.2), but the first
  // frame is a picture, and the clip inherits whatever composition it is given.
  //
  // Short fragments on purpose. Long frame prompts make the render worse, so
  // this is four clauses at most and every one of them is derived, never prose.
  const size = SIZES.includes(spec.size) ? spec.size : sizeFor(spec.type);
  const camera = [
    HEIGHT[size] || null,
    // One thing near the lens, with the subject behind it. Flat frames -
    // subject centred, background behind, nothing in front - are the single
    // most illustration-like thing about the current shots.
    size === 'insert' ? null : clean(spec.foreground) ? `${clean(spec.foreground)} in the near foreground` : null,
    // Off to one side, looking into the space, rather than dead centre.
    OFFSET[size] || null,
    // One light direction for the whole scene, exactly as one sound bed runs
    // the whole scene (5.10). Without it each frame invents its own.
    clean((spec.sceneRow || {}).key_light) || null,
    // 5.14 - where things STAND, stated once per scene. `screen_direction` says
    // which way the scene faces; nothing said where the car was relative to the
    // person beside it, so every shot decided again - in one render the
    // a vehicle was beside Doc and in the next it was behind him. It is also what
    // an inserted shot gets positioned against; without it there is nothing to
    // position it relative to.
    clean((spec.sceneRow || {}).staging) || null
  ]
    .filter(Boolean)
    .map((f) => upFirst(String(f).trim()))
    .join('. ');

  // 5.4 - the scene's look, word for word on every shot of the scene, is what
  // makes the cuts inside a scene match.
  const frame_prompt = `${STYLE.frame} ${frame}. ${camera ? camera + '. ' : ''}Setting: ${clean(spec.look)}.${refNote}`;

  let action = anonymise(noCamera(clean(spec.action)), (spec.unnamed || [])) || 'The moment holds';
  // Props are described in the motion prompt too, not only the first frame.
  // The frame decides what the object looks like at frame 0; the motion prompt
  // is what the video model reads for the rest of the shot, and it is also what
  // the Context Loop plan's detailed_description is built from - so a prop bound
  // only into the frame never reaches that path at all.
  for (const prop of propList) {
    for (const alias of prop.names) {
      const r = bindSubject(action, alias, prop.look);
      if (r.bound) {
        action = r.text;
        break;
      }
    }
  }
  const sound =
    lower(clean((spec.sceneRow || {}).sound_ambience)) || lower(clean(spec.sound)) || 'a soft breeze';
  let motion_prompt;
  if (spec.line) {
    const t = lineTiming(spec.line.text);
    motion_prompt = `${STYLE.motion} ${action}. At ${pad(t.start)}, ${spec.line.character} (S1) says: <d>[English] ${spec.line.text}</d> Overall soundscape: ${sound}.`;
  } else {
    motion_prompt = `${STYLE.motion} ${action}. The only sounds are ${sound}. Non-diegetic music: N/A.`;
  }

  // `action` comes back as well: it is the prompt's wording with the props bound
  // into it, and the shot list shows it as the row's note. Reaching for the loop's
  // own copy instead threw a ReferenceError the moment this became a function.
  return { frame_prompt, motion_prompt, action, refs, size, notes };
}

const built = [];
let prevScene = null;
let lastLineChar = null; // who spoke last, so a reaction never shows them (5.3)
for (const s of shots) {
  const scene = Number(s.scene) || beatByCode[s.beat]?.scene_number || prevScene || 1;
  const line = s.line ? lineById[s.line] : null;
  // 5.18 - what the screenplay says these people are wearing, worked out before
  // anything is written, because it decides what the descriptions say. A costume
  // REPLACES the clothes in a character's description rather than being added
  // alongside them.
  shotCostume = {};
  {
    const br = beatByCode[s.beat];
    if (br && Array.isArray(br.characters)) {
      for (const c of br.characters) {
        const want = c && c.wardrobe ? String(c.wardrobe).trim().toLowerCase() : '';
        if (!want) continue;
        const pr = propList.find((x) => x.kind === 'wardrobe' && x.names.includes(want));
        if (pr && pr.look) shotCostume[String(c.name || '').toUpperCase()] = pr.look;
      }
    }
  }
  let names = (Array.isArray(s.characters) ? s.characters : []).map((n) => String(n).toUpperCase()).filter((n) => charNames.has(n));
  names = [...new Set(names)];
  if (line && !names.includes(line.character)) {
    names.unshift(line.character);
    fixes.push(`shot for ${line.id}: put the speaker ${line.character} on screen`);
  }
  // 5.5 - put back anyone the text shows but the model forgot to list, and
  // 5.3 - keep the speaker off their own reaction shot. A reaction names the
  // person being reacted to ("RED listening to CHIBI", "Red pulls back,
  // surprised by PINKY"), which would otherwise drag the speaker into frame.
  const said = `${s.frame || ''} ${s.action || ''}`;
  const silentReaction = String(s.type) === 'reaction' && !line;
  // 5.3 - with nobody else in the scene there is nobody to react: Milo reacted
  // to Milo, because the reaction rule only fires when someone else is present.
  // The shot is fine, the label is not.
  if (silentReaction && names.length === 1 && names[0] === lastLineChar) {
    s.type = 'close';
    fixes.push(`shot ${built.length + 1}: ${lastLineChar} was the only one in the scene, so it was reacting to itself - made it a close shot`);
  }
  if (silentReaction && lastLineChar && names.includes(lastLineChar) && names.length > 1) {
    names = names.filter((n) => n !== lastLineChar);
    fixes.push(`shot ${built.length + 1}: took the speaker ${lastLineChar} off their own reaction shot`);
  }
  // 5.5, the Name rule. Everyone the text names gets a reference while there is
  // room for one - Image Edit takes four. Past that the name is taken out of the
  // prompt rather than rendered from the word.
  const mentioned = namesIn(said).filter((n) => !names.includes(n) && !(silentReaction && n === lastLineChar));
  const attached = mentioned.slice(0, Math.max(0, 4 - names.length));
  const unnamed = mentioned.slice(attached.length);
  if (attached.length) {
    names.push(...attached);
    fixes.push(`shot ${built.length + 1}: ${attached.join(', ')} ${attached.length > 1 ? 'were' : 'was'} in the frame but not listed - put them on screen`);
  }
  if (unnamed.length) {
    fixes.push(`shot ${built.length + 1}: no reference left for ${unnamed.join(', ')} - not named in the prompt`);
  }
  if (!names.length && GROUP_WORDS.test(said)) {
    names = [...(present[scene] || [])];
    if (names.length) fixes.push(`shot ${built.length + 1}: "${(said.match(GROUP_WORDS) || [])[0]}" with nobody listed - put scene ${scene}'s cast on screen`);
  }
  // A counted group with too few listed: "The five watch in awe" had four.
  const wantN = saidCount(said);
  if (wantN > names.length) {
    const rest = [...(present[scene] || []), ...charNames].filter((n) => !names.includes(n));
    const added = [...new Set(rest)].slice(0, wantN - names.length);
    if (added.length) {
      names = [...names, ...added];
      fixes.push(`shot ${built.length + 1}: the frame says ${wantN} but ${wantN - added.length} were listed - added ${added.join(', ')}`);
    }
  }
  const type = TYPES.includes(String(s.type)) ? String(s.type) : 'medium';
  // 5.4 - "continue" means no cut: the clip starts from the previous one's tail,
  // picture and sound, so the two play as one take. It cannot cross a scene
  // change, cannot open a scene, and cannot be a reaction or an establishing
  // shot - both of those are a new angle by definition.
  const neverContinues = type === 'reaction' || type === 'establishing';
  const continuity =
    s.continuity === 'continue' && prevScene === scene && built.length && !neverContinues ? 'continue' : 'fresh';
  if (s.continuity === 'continue' && continuity === 'fresh') {
    fixes.push(
      `shot ${built.length + 1}: "continue" ${neverContinues ? 'on a ' + type + ' shot' : 'across a scene change'} - made fresh`
    );
  }

  // 5.5 - more than four on screen: no references, framed from behind, each
  // told apart by hair and outfit only, in the order given.
  // Both prompts, built from the script's words and today's tables. The same
  // call a redo makes, so a redrafted prompt and a rebuilt one are the same
  // sentence.
  const composed = composeShot({
    label: String(built.length + 1),
    scene,
    sceneRow: sceneByNum[scene] || {},
    look: lookOf(scene),
    type,
    size: s.size,
    foreground: s.foreground,
    names,
    fromBehind,
    subjects,
    frame: s.frame,
    action: s.action,
    line,
    sound: s.sound,
    unnamed,
    costumes: shotCostume
  });
  const { frame_prompt, motion_prompt, action, size } = composed;
  const refs = composed.refs;
  fixes.push(...composed.notes);

  // 5.18 - the screenplay decides what people are wearing, and the Director
  // reads it. A costume put on in the Director is written back onto the beat's
  // character entry, so a redraft finds it there and keeps it instead of
  // silently undressing everyone from a script that never mentioned it.
  const beatRow = beatByCode[s.beat];
  const wardrobe = (() => {
    if (!beatRow || !Array.isArray(beatRow.characters)) return null;
    const pairs = [];
    for (const c of beatRow.characters) {
      const want = c && c.wardrobe ? String(c.wardrobe).trim().toLowerCase() : '';
      if (!want) continue;
      const pr = propList.find((x) => x.kind === 'wardrobe' && x.names.includes(want));
      if (!pr) continue;
      // The script says "DR. EMMETT BROWN" where the cast list says "BROWN".
      const nm = String(c.name || '').toUpperCase();
      const who = (refs.length ? refs : names).find(
        (n) => n === nm || nm.includes(n) || n.includes(nm)
      );
      if (who) pairs.push({ prop: pr.id, on: who });
    }
    return pairs.length ? pairs : null;
  })();

  built.push({
    scene, beat: beatByCode[s.beat] ? s.beat : null, type, names: refs.length ? refs : names, continuity,
    wardrobe,
    // Kept apart from type so the "never twice the same size" check below has
    // something to compare, and so the shot list can show it.
    // `nothing()` because the model answers an optional field with the WORD
    // rather than the value: 28 of 79 Back to the Future shots had the literal
    // string "null" stored as their foreground, which then printed as "null"
    // under the shot size and would have been pasted into a frame prompt as
    // "null in the near foreground".
    size, foreground: nothing(s.foreground) ? null : clean(s.foreground),
    frame_prompt, motion_prompt, length_frames: frameCount(s), silent: !line,
    // The sentences BEFORE anything was bound into them. A prompt is baked -
    // anchors, descriptions, camera and light pasted in, the original gone -
    // so a description improved later reached nothing short of redrafting the
    // whole plan and losing every approved frame with it. Kept, a prompt goes
    // back to being a derived value that can be rebuilt from today's tables.
    raw_frame: clean(s.frame) || null,
    raw_action: clean(s.action) || null,
    // Where the speech actually stops, for 5.8: the grid rounds a line's clip UP,
    // so there is a second or two of silence on the end that the cut can drop.
    speechEnd: line ? Math.ceil((lineTiming(line.text).seconds - 1.0) * 24) : null,
    notes: line ? `${action} - ${line.character}: "${line.text}"` : action
  });
  prevScene = scene;
  if (line) lastLineChar = line.character;
}

// A reaction that answers a line, and every establishing shot, are required by
// 5.3 - trimming must never take them.
built.forEach((s, i) => {
  const prev = built[i - 1];
  if (s.type === 'establishing') s.required = true;
  if (s.type === 'reaction' && prev && !prev.silent && prev.scene === s.scene) s.required = true;
});

// 5.9 - nothing is stretched, shrunk or dropped to reach a runtime, and a draft
// is never rejected for its length: the film is as long as the script is. The
// one trim left is the coverage cap - a draft that invents shots beyond what
// covers the script loses the least important silent ones.
//
// Surplus reactions go first. Ranking wides and inserts below them emptied the
// film once: trimming took the RED/BLONDI clash, the cracking crystal and both
// shots of the group attacking the beast, and left three reaction shots in a
// row in scene 3 - all the action gone, all the talking heads kept. The
// reactions 5.3 requires, and every establishing shot, are marked required and
// are never dropped.
const total = () => built.reduce((n, s) => n + s.length_frames, 0) / 24;
const RANK = { reaction: 0, cutaway: 1, insert: 2, wide: 3, medium: 4, close: 5, establishing: 9 };
// Not when inserting: the cap is what stops a DRAFT inventing shots beyond
// what the script covers. One shot the operator asked for by hand is never
// surplus, and trimming it would make the button do nothing.
for (let guard = 0; repair && guard < 200 && built.length > coverageShots; guard++) {
  const droppable = built.filter((s) => s.silent && !s.required);
  if (!droppable.length) break;
  droppable.sort((a, b) => (RANK[a.type] === undefined ? 6 : RANK[a.type]) - (RANK[b.type] === undefined ? 6 : RANK[b.type]));
  const gone = droppable[0];
  built.splice(built.indexOf(gone), 1);
  fixes.push(`dropped a ${gone.type} shot in scene ${gone.scene} - beyond what covers the script`);
}

const seconds = total();

// ------------------------------------------------- 5.8 the cut window
// The clip is generated at MiniMax's floor; the CUT uses part of it. Without
// this every silent shot is 5.2 s and the film cuts on a metronome - a reaction
// held as long as an establishing shot. The flow computes the window, never the
// model.
const KEEP = { reaction: 44, insert: 30, cutaway: 36, establishing: 60, wide: 48, medium: 48, close: 48 };
const LEAD_IN = 12; // the first frames are the still first frame barely moving
const TAIL_GUARD = 8; // the last frames drift
const CUT_FLOOR = 24; // under a second a cut reads as a flash, not a shot
for (const s of built) {
  if (!s.silent) {
    // A line plays from the top - the run-up to it is part of the shot - and
    // ends a beat after the speech does. Never cut into the words.
    s.use_start_frame = 0;
    s.use_frames = Math.min(s.length_frames, Math.max(CUT_FLOOR, (s.speechEnd || 0) + 6));
  } else {
    const room = s.length_frames - LEAD_IN - TAIL_GUARD;
    s.use_start_frame = LEAD_IN;
    s.use_frames = Math.max(CUT_FLOOR, Math.min(KEEP[s.type] === undefined ? 48 : KEEP[s.type], room));
  }
}
const cutFrames = built.reduce((n, s) => n + s.use_frames, 0);
const cutSeconds = cutFrames / 24;

// --------------------------------------------------------------- write
//
// An insert adds one row beside shots that already exist, so it shifts rather
// than replaces. Shifted from the BACK forwards: position has to stay unique per
// plan while the shift is in progress, and moving the lowest one first would
// collide with the row above it.
if (inserting) {
  const one = built[0];
  if (!one) return { error: 'Nothing was built from that shot.' };
  const at = Math.max(1, Math.min(existing.length + 1, Math.round(Number(parsed.position) || existing.length + 1)));
  const after = existing.filter((x) => x.position >= at).sort((a, b) => b.position - a.position);
  for (const row of after) {
    const mv = await axios.patch(
      `${insforgeUrl}/api/database/records/director_shots`,
      { position: row.position + 1 },
      { params: { id: `eq.${row.id}` }, headers: jsonHeaders, validateStatus: () => true }
    );
    if (mv.status < 200 || mv.status >= 300) {
      return { error: `Could not make room at position ${at}: HTTP ${mv.status} moving shot ${row.position}.` };
    }
  }
  const row = {
    plan_id: plan.id,
    movie_id: movie.id,
    position: at,
    scene_number: one.scene,
    beat_id: one.beat && beatByCode[one.beat] ? beatByCode[one.beat].id : null,
    shot_type: one.type,
    shot_size: one.size,
    foreground: one.foreground,
    characters: one.names,
    length_frames: one.length_frames,
    use_start_frame: one.use_start_frame,
    use_frames: one.use_frames,
    continuity: one.continuity,
    // What the screenplay says these people are wearing. The insert path builds
    // its own row rather than going through the redraft's mapper, so a field
    // added there has to be added here too - this one was missed, and an
    // inserted shot came out with no costume however the beat was dressed.
    wardrobe: one.wardrobe,
    frame_prompt: one.frame_prompt,
    motion_prompt: one.motion_prompt,
    raw_frame: one.raw_frame,
    raw_action: one.raw_action,
    status: 'planned',
    notes: one.notes,
    // Marked, so a later redraft can tell what the automation chose from what
    // was put in by hand.
    source: 'inserted',
    // A first frame picked from the gallery, and optionally the frame this shot
    // must land on - which is how an arrival ends exactly where the next shot
    // begins instead of approximately.
    first_frame_path: String(parsed.firstFramePath || '').trim() || null,
    last_frame_path: String(parsed.lastFramePath || '').trim() || null
  };
  if (row.first_frame_path) row.status = 'framed';
  const put = await axios.post(`${insforgeUrl}/api/database/records/director_shots`, [row], {
    headers: jsonHeaders,
    validateStatus: () => true
  });
  const wrote = Array.isArray(put.data) ? put.data.length : 0;
  if (put.status < 200 || put.status >= 300 || wrote !== 1) {
    return {
      error: `The shot was built but not written (HTTP ${put.status}).`,
      detail: JSON.stringify(put.data).slice(0, 500)
    };
  }
  return {
    action: 'inserted',
    position: at,
    scene: one.scene,
    shifted: after.length,
    frame_prompt: one.frame_prompt,
    motion_prompt: one.motion_prompt,
    length_frames: one.length_frames,
    fixes,
    note: `Shot inserted at ${at}. It carries the same character, prop, camera and scene bindings as a planned shot.`
  };
}

await axios.delete(`${insforgeUrl}/api/database/records/director_shots`, { params: { plan_id: `eq.${plan.id}` }, headers: authHeaders });
const rows = built.map((s, i) => ({
  plan_id: plan.id,
  movie_id: movie.id,
  position: i + 1,
  scene_number: s.scene,
  beat_id: s.beat ? beatByCode[s.beat].id : null,
  shot_type: s.type,
  shot_size: s.size,
  foreground: s.foreground,
  characters: s.names,
  length_frames: s.length_frames,
  use_start_frame: s.use_start_frame,
  use_frames: s.use_frames,
  continuity: s.continuity,
  wardrobe: s.wardrobe,
  frame_prompt: s.frame_prompt,
  raw_frame: s.raw_frame,
  raw_action: s.raw_action,
  motion_prompt: s.motion_prompt,
  status: 'planned',
  notes: s.notes
}));
// The insert used to be fire-and-forget, and the plan was marked "planned"
// whatever came back - so a rejected write looked exactly like a successful one:
// a plan with status "planned" and no shots in it, and nothing anywhere saying
// why. Check it, and refuse to mark the plan planned unless the rows are in.
if (!rows.length) {
  return { error: 'The draft produced no shots, so nothing was written.', shots: 0, rounds, issues, fixes };
}
const ins = await axios.post(`${insforgeUrl}/api/database/records/director_shots`, rows, {
  headers: jsonHeaders,
  validateStatus: () => true
});
const wrote = Array.isArray(ins.data) ? ins.data.length : 0;
if (ins.status < 200 || ins.status >= 300 || wrote !== rows.length) {
  return {
    error: `Writing the shot list failed - ${wrote} of ${rows.length} rows were inserted (HTTP ${ins.status}).`,
    detail: JSON.stringify(ins.data).slice(0, 700),
    shots: rows.length
  };
}
await axios.patch(
  `${insforgeUrl}/api/database/records/director_plans`,
  { status: 'planned', target_seconds: targetSeconds, updated_at: new Date().toISOString() },
  { params: { id: `eq.${plan.id}` }, headers: jsonHeaders }
);

const perScene = {};
for (const s of built) perScene[s.scene] = (perScene[s.scene] || 0) + 1;
return {
  action: 'planned',
  movie: movie.title,
  planId: plan.id,
  style: styleKey,
  shots: built.length,
  seconds: Number(seconds.toFixed(1)),
  runtime: clock(seconds),
  // What gets generated vs what reaches the cut (5.8).
  cutSeconds: Number(cutSeconds.toFixed(1)),
  cutRuntime: clock(cutSeconds),
  targetSeconds,
  coverageShots,
  breakdown: {
    dialogue: lines.length,
    reactions: requiredReactions,
    establishing: requiredEstablishing,
    action: actionShots
  },
  advice,
  perScene,
  lines: lines.length,
  retried: rounds > 0,
  rounds,
  remainingIssues: issues,
  fixes,
  model: ollamaModel
};
