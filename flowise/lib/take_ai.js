// A take drafted by the language model: the performance, from the script.
//
// Included with `// @include take_ai`. The model reads the Director's shots (what
// happens, who says what and when) and the set (its marks, and what is near each)
// and writes where each person is and when they move, as data for
// blender/build_take.py. As with block-outs, the model writes data, the flow
// checks it, and a draft that fails the checks goes back once with the problems.

const TAKE_RULES = [
  'You are blocking a scene for the camera: deciding where each actor stands, when they move, where they walk to',
  'and what they face, so that several cameras can later film the same performance from different angles.',
  '',
  'You may only use the marks listed for this set. A move is {t, mark, facing, pose}: at time t (seconds from the',
  'start of the take) the person is standing (or sitting) on that mark, facing that mark. Between two moves on',
  'different marks they walk; between two moves on the same mark they stay, and turn if the facing changes.',
  '',
  'Rules:',
  '- The first move is at t 0: where each person is when the take starts.',
  '- People walk at about 1 m/s, never faster than 1.5 m/s: leave enough time between two marks for the distance.',
  '- Only move people when the script gives them a reason: they go to something they use or look at, or away from',
  '  someone. A person who only listens, looks or speaks can stay on one mark and turn.',
  '- Facing: face what the script says they look at or use (a mark by it), or the person they speak to.',
  '- ANCHOR_stand_* marks are places to stand; ANCHOR_sit_* are seats (pose "seated"); other marks are things to',
  '  face, which people do not stand on.',
  '- Cues are the moments that matter, with times: an action ("TOMAS checks his wristwatch") or a line',
  '  ("TOMAS says: \\"You\'re early.\\""). Keep a line at the time the script gives it, counted from the start of',
  '  its shot, which is given below.',
  '- Every time is between 0 and the length of the take.',
  '- Only people who are seen are performers. A voice on a radio or from off screen is not: give its line as a cue.'
].join('\n');

/** The marks, where they are, and what set piece each is near, as lines for the prompt. */
function takeMarks(facts) {
  const anchors = (facts && facts.anchors) || {};
  const objects = ((facts && facts.blockout && facts.blockout.objects) || []).filter((o) => o.at && !o.cover && !o.exterior);
  const pieces = (facts && facts.set_pieces) || {};
  // Walls, floor and ceiling are near every mark and say nothing about where it is.
  const pieceOf = (name) => Object.keys(pieces).filter((p) => !/wall|floor|ceiling/i.test(p))
    .find((p) => (pieces[p] || []).some((prefix) => String(name).startsWith(prefix)));
  return Object.entries(anchors).map(([name, p]) => {
    let near = null;
    let best = Infinity;
    for (const o of objects) {
      const d = Math.hypot(o.at[0] - p[0], o.at[1] - p[1]);
      if (d < best && pieceOf(o.name)) { best = d; near = pieceOf(o.name); }
    }
    return `${name}: x ${Number(p[0]).toFixed(2)}, y ${Number(p[1]).toFixed(2)}${near && best < 1.2 ? `, by ${near} (${best.toFixed(1)} m)` : ''}`;
  });
}

/**
 * The prompt. ctx: {setName, facts, frames, people: [names], shots: [{start, seconds, type, text}], notes}
 */
function takePrompt(ctx) {
  const d = (ctx.facts && ctx.facts.dimensions_m) || {};
  const shape = ((ctx.facts && ctx.facts.blockout && ctx.facts.blockout.room) || {}).shape === 'round' ? `round, ${d.width} m across` : `${d.width} m by ${d.depth} m`;
  return [
    TAKE_RULES,
    '',
    `The set: ${ctx.setName}, ${shape}. Metres, north is +y, east is +x, the middle of the room is 0, 0.`,
    'Marks:',
    ...takeMarks(ctx.facts).map((l) => '  ' + l),
    '',
    `People: ${ctx.people.join(', ')}.`,
    `The take is ${(ctx.frames / 24).toFixed(2)} seconds long and covers these shots, in order:`,
    ...ctx.shots.map((s, i) => `  Shot ${i + 1}, from ${s.start.toFixed(1)}s to ${(s.start + s.seconds).toFixed(1)}s (${s.type || 'shot'}): ${s.text}`),
    ctx.notes ? '\nNotes from the director: ' + ctx.notes : '',
    '',
    'Answer with JSON only:',
    '{"reading": "two or three sentences: what happens, and where people need to be for it",',
    ' "performers": [{"name": "TOMAS", "keys": [{"t": 0, "mark": "ANCHOR_...", "facing": "ANCHOR_...", "pose": "standing"}, ...]}],',
    ' "cues": [{"t": 4.0, "text": "..."}]}'
  ].join('\n');
}

/** What is wrong with a drafted take, in words the model can act on. */
function takeProblems(draft, facts, frames) {
  const out = [];
  const anchors = (facts && facts.anchors) || {};
  const len = frames / 24;
  const performers = (draft && draft.performers) || [];
  if (!performers.length) out.push('there are no performers');
  for (const p of performers) {
    const who = p.name || 'someone';
    const keys = [...(p.keys || [])].sort((a, b) => Number(a.t) - Number(b.t));
    if (!keys.length) { out.push(`${who} has no moves`); continue; }
    if (Number(keys[0].t) > 0.01) out.push(`${who}'s first move must be at t 0`);
    keys.forEach((k, i) => {
      if (!anchors[k.mark]) out.push(`${who} at ${k.t}s: ${k.mark} is not one of the marks`);
      else if (!/^ANCHOR_(stand|sit)_/.test(k.mark)) out.push(`${who} at ${k.t}s: ${k.mark} is a thing to face, not a place to stand`);
      if (k.facing && !anchors[k.facing]) out.push(`${who} at ${k.t}s: facing ${k.facing}, which is not one of the marks`);
      if (!(Number(k.t) >= 0 && Number(k.t) <= len)) out.push(`${who}: a move at ${k.t}s is outside the ${len.toFixed(1)}s take`);
      if (i > 0 && anchors[k.mark] && anchors[keys[i - 1].mark]) {
        const a = anchors[keys[i - 1].mark];
        const b = anchors[k.mark];
        const dist = Math.hypot(b[0] - a[0], b[1] - a[1]);
        const dt = Number(k.t) - Number(keys[i - 1].t);
        if (dist > 0.05 && dist / Math.max(dt, 1e-3) > 1.5) out.push(`${who} walks ${dist.toFixed(1)} m in ${dt.toFixed(1)}s between ${keys[i - 1].t}s and ${k.t}s: too fast, allow at least ${(dist / 1.0).toFixed(1)}s`);
      }
    });
  }
  for (const c of (draft && draft.cues) || []) {
    if (!(Number(c.t) >= 0 && Number(c.t) <= len)) out.push(`the cue "${c.text}" at ${c.t}s is outside the take`);
  }
  return out;
}

/** The draft in the shape save_take takes (and the Takes editor shows). */
function takeForSave(draft) {
  return {
    performers: ((draft && draft.performers) || []).map((p) => ({
      name: p.name,
      keys: [...(p.keys || [])].sort((a, b) => Number(a.t) - Number(b.t)).map((k) => ({
        t: Math.round(Number(k.t) * 10) / 10, mark: k.mark, facing: k.facing || undefined, pose: k.pose === 'seated' ? 'seated' : 'standing'
      }))
    })),
    cues: ((draft && draft.cues) || []).map((c) => ({ t: Math.round(Number(c.t) * 10) / 10, text: String(c.text || '') }))
  };
}
