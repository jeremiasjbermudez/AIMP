// A staged Blender shot as a MiniMax H3 control clip: the prompt.
//
// Included with `// @include set_clip`. From camera_lab's compile_shot.py
// build_prompt and visibility_text, without the parts that belonged to one
// film (a named speaker, a line of dialogue with timings, a hood and a tie):
// here the action comes from the Director's shot or the beat.
//
// The prompt has to say what the depth video cannot: who the person is and
// where the camera stands relative to them (a camera behind the actor otherwise
// comes back as a frontal shot, because the depth proxy's back reads as a
// front), what the room holds and what never appears (or H3 invents windows),
// and what each picture is.

/** Where the camera is, seen from the actor: + is to their left, as in camera_lab. */
function setClipViewPhrase(a, who) {
  const side = a > 0 ? 'left' : 'right';
  const x = Math.abs(a);
  if (x <= 35) return `in front of ${who}: they face the lens and their face is fully visible`;
  if (x <= 110) return `off to ${who}'s ${side} at about ${Math.round(x)} degrees: a three-quarter view of their face, the far side partly hidden`;
  if (x <= 150) return `behind ${who} and to their ${side}: an over-the-shoulder view, their face turned away from the lens`;
  return `directly behind ${who}: the back of their head and shoulders fill the frame and their face is not visible`;
}

/** Sentences from the visibility pass: what is in frame, where, and what never appears. */
function setClipVisibility(vis) {
  const su = (vis && vis.summary) || null;
  if (!su) return '';
  const pl = vis.placement || {};
  const out = [];
  if (su.always && su.always.length) {
    out.push('In frame throughout: ' + su.always.map((g) => `${/^the /.test(g) ? g : 'the ' + g}${pl[g] ? ' at the ' + pl[g] + ' of frame' : ''}`).join(', ') + '.');
  }
  if (su.sometimes && su.sometimes.length) out.push('Entering or leaving frame during the move: ' + su.sometimes.join(', ') + '.');
  if (su.never && su.never.length) {
    out.push('Not in this shot at any moment: ' + su.never.join(', ') + '.');
    const openings = su.never.filter((g) => /window|door/i.test(g)).map((g) => g.replace(/^the /i, ''));
    if (openings.length) out.push(`No ${openings.join(' and no ')} appears anywhere in this shot; do not add any window, doorway or opening to the walls in view.`);
  }
  return out.join(' ');
}

/** A mark's name as words: ANCHOR_stand_stove -> "the stove", ANCHOR_stand_center -> "the middle of the room". */
function setClipPlace(anchor) {
  const w = String(anchor || '').replace(/^ANCHOR_/, '').replace(/^(stand|sit)_/, '').replace(/_/g, ' ').trim();
  if (/^(center|centre|middle)$/i.test(w)) return 'the middle of the room';
  return w ? 'the ' + w : 'their mark';
}

/**
 * A take's performance as sentences with times, for the prompt: where each
 * performer starts, when they walk, turn, sit or stand, and the cues.
 */
function setClipTimeline(take) {
  const out = [];
  const where = (k) => (k.mark ? setClipPlace(k.mark) : 'their place');
  const facing = (k) => (k.facing ? setClipPlace(k.facing) : null);
  for (const p of (take && take.performers) || []) {
    const who = p.display || p.id;
    const keys = [...(p.keys || [])].sort((a, b) => a.t - b.t);
    if (!keys.length) continue;
    const k0 = keys[0];
    const f0 = facing(k0);
    out.push(`At the start ${who} ${k0.pose === 'seated' ? 'sits' : 'stands'} at ${where(k0)}${f0 ? `, facing ${f0 === where(k0) ? 'it' : f0}` : ''}.`);
    for (let i = 1; i < keys.length; i++) {
      const a = keys[i - 1];
      const b = keys[i];
      const moved = (a.mark || JSON.stringify(a.at)) !== (b.mark || JSON.stringify(b.at));
      if (moved) out.push(`From ${a.t.toFixed(1)}s to ${b.t.toFixed(1)}s ${who} walks from ${where(a)} to ${where(b)}${facing(b) && facing(b) !== where(b) ? `, and turns to face ${facing(b)}` : ''}.`);
      else if (facing(b) && facing(b) !== facing(a)) out.push(`At ${b.t.toFixed(1)}s ${who} turns to face ${facing(b)}.`);
      if (a.pose !== b.pose) out.push(`At ${b.t.toFixed(1)}s ${who} ${b.pose === 'seated' ? 'sits down' : 'stands up'}.`);
    }
  }
  for (const c of [...((take && take.cues) || [])].sort((a, b) => a.t - b.t)) {
    // No full stop after a cue that already ends a sentence (a quoted line).
    if (c.text) out.push(`At ${Number(c.t).toFixed(1)}s: ${c.text}${/[.!?]"?$/.test(c.text) ? '' : '.'}`);
  }
  return out;
}

/**
 * Mark the timeline's mentions of things this camera never sees as out of frame.
 * "He looks at the wall calendar" with the calendar never in frame made H3 draw the
 * calendar anyway, and a second him to use it; the prompt must say he looks off frame.
 */
function setClipOffFrame(sentences, vis) {
  const never = (((vis || {}).summary || {}).never || []).map((g) => String(g).replace(/^the /i, ''));
  return (sentences || []).map((line) => {
    const hit = never.filter((g) => {
      const word = g.split(/\s+/).pop();
      // The first five letters: "the stairs" (a mark's name) is "the stairwell" (a set piece).
      return word && word.length > 3 && new RegExp('\\b' + word.slice(0, 5).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\w*', 'i').test(line);
    });
    return hit.length ? `${line} (${hit.map((g) => 'the ' + g).join(' and ')} ${hit.length === 1 ? 'is' : 'are'} out of frame in this shot: he looks off frame toward ${hit.length === 1 ? 'it' : 'them'}; do not draw ${hit.length === 1 ? 'it' : 'them'}.)` : line;
  });
}

/**
 * The whole prompt.
 *   p.locationName, p.roomPrompt, p.lensMm, p.frames, p.fps
 *   p.person {name, look} or null     p.pictures: number of look plates after <Picture 1>
 *   p.view {start_deg, end_deg, start_m, end_m} or null
 *   p.trajectory {type, hold_until_s, move_end_s, total_s, radius_end_ratio}
 *   p.action: what happens, from the Director's shot or the beat
 *   p.timeline: sentences from a take (setClipTimeline), when the shot is on one
 *   p.cameraMotion {travel_m, pan_deg}; p.recorded: the camera was operated
 *   p.timeOfDay (NIGHT, DAY...), p.lights (the set's light names), p.lookFromScene: the
 *   pictures are the scene's own panorama, so they also set the light and colour
 *   p.visibility: the shot's visibility result
 */
function setClipPrompt(p) {
  const who = p.person ? p.person.name : 'the subject';
  const tr = p.trajectory || { type: 'hold', hold_until_s: 1, move_end_s: 1, total_s: p.frames / p.fps };
  const lines = [];
  lines.push(`One continuous photorealistic live-action shot in the ${p.locationName}, ${p.lensMm}mm lens.`);
  if (p.person) {
    lines.push(`${p.person.name} from <Picture 1>${p.person.look ? ` (${p.person.look})` : ''} is the only person in the shot.`);
    // A take's timeline lists things he does; without this, H3 has been seen to add a second
    // him in an empty background to act them out (Testies LK_S1_0203_MED).
    lines.push(`There is no one else anywhere in the room: no second figure, no double or reflection of ${p.person.name}. Everything in the timeline is done by the one ${p.person.name} the depth guide places.`);
    if (p.view) {
      const a0 = p.view.start_deg;
      const a1 = p.view.end_deg;
      const v0 = setClipViewPhrase(a0, who);
      const v1 = setClipViewPhrase(a1, who);
      lines.push(Math.abs(a1 - a0) < 15 || v0 === v1 ? `The camera is ${v0}.` : `At the start the camera is ${v0}; by the end of the move it is ${v1}.`);
      // On a mark the actor stays put, so a rear camera must not bring them round to face it.
      // On a take they walk and turn, and the timeline says when.
      if (!(p.timeline && p.timeline.length) && (Math.abs(a0) > 35 || Math.abs(a1) > 35)) lines.push(`${who} keeps facing the same direction in the room throughout and does not turn toward the camera.`);
    }
  }
  // On a take the timeline is the action, lines included, at the take's times; the Director
  // shot's own text would give the same line a second time, counted from its own start.
  if (p.timeline && p.timeline.length) lines.push(setClipOffFrame(p.timeline, p.visibility).join(' '));
  else if (p.action) lines.push(String(p.action).trim().replace(/\s+/g, ' '));
  lines.push('');
  lines.push(p.person
    ? `The camera path and ${who}'s position, size and pose at every frame are given by the structural depth guide; render the real person from <Picture 1> in that place, at that scale.`
    : 'The camera path is given by the structural depth guide.');
  // The time of day and what lights the room: without it H3 lit a night scene as day.
  if (p.timeOfDay) {
    const night = /night|evening|dusk/i.test(p.timeOfDay);
    const lamps = (p.lights || []).map((l) => String(l).toLowerCase());
    lines.push(night
      ? `It is night${/evening|dusk/i.test(p.timeOfDay) ? ` (${p.timeOfDay.toLowerCase()})` : ''}.${lamps.length ? ` The room is lit only by the ${lamps.join(', the ')}.` : ''} Outside it is dark: no daylight anywhere.`
      : `It is ${p.timeOfDay.toLowerCase()}.${lamps.length ? ` Light comes from the ${lamps.join(', the ')}.` : ''}`);
  }
  const vis = setClipVisibility(p.visibility);
  if (vis) lines.push(vis);
  if (p.pictures > 0) {
    const first = p.person ? 2 : 1;
    const tags = Array.from({ length: p.pictures }, (_, i) => `<Picture ${first + i}>`).join(', ');
    lines.push(`${tags} ${p.pictures === 1 ? 'is a photograph' : 'are photographs'} of this same ${String(p.locationName).toLowerCase()} taken from other positions. They define the room's real materials, furniture, props, windows, walls${p.lookFromScene ? ', light and colour' : ''}. Reproduce that exact room wherever the camera looks; do not invent furniture or fittings that are not in them. They are not camera views for this shot.`);
  }
  // No room description here: it names everything in the room (the window, the
  // stove), and H3 then puts them in shots whose camera never sees them. The
  // room reaches the clip through the look plates, which carry it as pictures,
  // and the visibility sentences say what this camera sees. camera_lab's prompts
  // kept it out too.
  lines.push('');
  const total = Number(tr.total_s || p.frames / p.fps);
  const hold = Number(tr.hold_until_s || 0);
  const end = Number(tr.move_end_s || hold);
  // A fixed camera that pans to follow is not a locked-off shot, whatever the stage calls it.
  const cm = p.cameraMotion || {};
  const pans = Number(cm.pan_deg) > 3 && Number(cm.travel_m) < 0.05;
  const travels = Number(cm.travel_m) >= 0.05;
  lines.push(`One continuous ${tr.type === 'hold' && !pans && !travels ? 'shot' : 'camera move'} over ${total.toFixed(3)}s at ${p.fps} fps.`);
  if (pans) {
    lines.push(`The camera stays where it is and pans to follow ${who}, turning about ${Math.round(cm.pan_deg)} degrees to keep them in frame as they move; it does not travel. Smooth, as on a fluid head.`);
  } else if (p.recorded) {
    lines.push(`The camera is operated by hand and moves exactly as the depth guide shows, travelling about ${Number(cm.travel_m).toFixed(1)} m; follow its path, including its small corrections.`);
  } else if (tr.type === 'push') {
    lines.push(`From 0.000s to ${hold.toFixed(3)}s: hold the camera still.`);
    lines.push(`From ${hold.toFixed(3)}s to ${end.toFixed(3)}s: move the CAMERA straight toward ${who} along the lens axis, keeping the lens aimed at their eyes, from radius 1.00 to ${Number(tr.radius_end_ratio || 1).toFixed(2)} times the start; ${who} stays where they are.`);
    lines.push(`From ${end.toFixed(3)}s to ${total.toFixed(3)}s: hold the camera still. Smoothstep easing within each segment.`);
  } else if (tr.type === 'hold') {
    lines.push('The camera does not move: a locked-off shot.');
  } else {
    lines.push(`From ${hold.toFixed(3)}s to ${end.toFixed(3)}s the camera travels as the depth guide shows, keeping the lens aimed at ${who}; real continuous parallax, the room passing behind them. Hold before and after. Smoothstep easing.`);
  }
  // An operated camera has its own small movements; asking for no sway would contradict them.
  lines.push(`${p.person ? '<Picture 1> is the identity and wardrobe reference, not the framing. ' : ''}Keep the focal length fixed and the camera roll zero. No cuts, no digital zoom, ${p.recorded ? '' : 'no handheld sway, '}no lighting changes, no titles or captions. ${p.frames} frames at ${p.fps} fps.`);
  return lines.join('\n');
}

/** The look-plate prompt: camera_lab's, for Z-Image over a Blender coverage plate. */
function setClipLookPrompt(roomPrompt) {
  return 'A real photograph of the same room, a single frame from a live-action feature film shot on a cinema camera. ' +
    String(roomPrompt || '').trim() +
    ' Natural film contrast, subtle grain. Not a render, not CGI, no perfectly regular repeated textures.';
}
