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
    const openings = su.never.filter((g) => /window|door/i.test(g));
    if (openings.length) out.push(`No ${openings.join(' and no ')} appears anywhere in this shot; do not add any window, doorway or opening to the walls in view.`);
  }
  return out.join(' ');
}

/**
 * The whole prompt.
 *   p.locationName, p.roomPrompt, p.lensMm, p.frames, p.fps
 *   p.person {name, look} or null     p.pictures: number of look plates after <Picture 1>
 *   p.view {start_deg, end_deg, start_m, end_m} or null
 *   p.trajectory {type, hold_until_s, move_end_s, total_s, radius_end_ratio}
 *   p.action: what happens, from the Director's shot or the beat
 *   p.visibility: the shot's visibility result
 */
function setClipPrompt(p) {
  const who = p.person ? p.person.name : 'the subject';
  const tr = p.trajectory || { type: 'hold', hold_until_s: 1, move_end_s: 1, total_s: p.frames / p.fps };
  const lines = [];
  lines.push(`One continuous photorealistic live-action shot in the ${p.locationName}, ${p.lensMm}mm lens.`);
  if (p.person) {
    lines.push(`${p.person.name} from <Picture 1>${p.person.look ? ` (${p.person.look})` : ''} is the only person in the shot.`);
    if (p.view) {
      const a0 = p.view.start_deg;
      const a1 = p.view.end_deg;
      const v0 = setClipViewPhrase(a0, who);
      const v1 = setClipViewPhrase(a1, who);
      lines.push(Math.abs(a1 - a0) < 15 || v0 === v1 ? `The camera is ${v0}.` : `At the start the camera is ${v0}; by the end of the move it is ${v1}.`);
      if (Math.abs(a0) > 35 || Math.abs(a1) > 35) lines.push(`${who} keeps facing the same direction in the room throughout and does not turn toward the camera.`);
    }
  }
  if (p.action) lines.push(String(p.action).trim().replace(/\s+/g, ' '));
  lines.push('');
  lines.push(p.person
    ? `The camera path and ${who}'s position, size and pose at every frame are given by the structural depth guide; render the real person from <Picture 1> in that place, at that scale.`
    : 'The camera path is given by the structural depth guide.');
  const vis = setClipVisibility(p.visibility);
  if (vis) lines.push(vis);
  if (p.pictures > 0) {
    const first = p.person ? 2 : 1;
    const tags = Array.from({ length: p.pictures }, (_, i) => `<Picture ${first + i}>`).join(', ');
    lines.push(`${tags} ${p.pictures === 1 ? 'is a photograph' : 'are photographs'} of this same ${String(p.locationName).toLowerCase()} taken from other positions. They define the room's real materials, furniture, props, windows and walls. Reproduce that exact room wherever the camera looks; do not invent furniture or fittings that are not in them. They are not camera views for this shot.`);
  }
  if (p.roomPrompt) lines.push('The room: ' + p.roomPrompt);
  lines.push('');
  const total = Number(tr.total_s || p.frames / p.fps);
  const hold = Number(tr.hold_until_s || 0);
  const end = Number(tr.move_end_s || hold);
  lines.push(`One continuous camera move over ${total.toFixed(3)}s at ${p.fps} fps.`);
  if (tr.type === 'push') {
    lines.push(`From 0.000s to ${hold.toFixed(3)}s: hold the camera still.`);
    lines.push(`From ${hold.toFixed(3)}s to ${end.toFixed(3)}s: move the CAMERA straight toward ${who} along the lens axis, keeping the lens aimed at their eyes, from radius 1.00 to ${Number(tr.radius_end_ratio || 1).toFixed(2)} times the start; ${who} stays where they are.`);
    lines.push(`From ${end.toFixed(3)}s to ${total.toFixed(3)}s: hold the camera still. Smoothstep easing within each segment.`);
  } else if (tr.type === 'hold') {
    lines.push('The camera does not move: a locked-off shot.');
  } else {
    lines.push(`From ${hold.toFixed(3)}s to ${end.toFixed(3)}s the camera travels as the depth guide shows, keeping the lens aimed at ${who}; real continuous parallax, the room passing behind them. Hold before and after. Smoothstep easing.`);
  }
  lines.push(`${p.person ? '<Picture 1> is the identity and wardrobe reference, not the framing. ' : ''}Keep the focal length fixed and the camera roll zero. No cuts, no digital zoom, no handheld sway, no lighting changes, no titles or captions. ${p.frames} frames at ${p.fps} fps.`);
  return lines.join('\n');
}

/** The look-plate prompt: camera_lab's, for Z-Image over a Blender coverage plate. */
function setClipLookPrompt(roomPrompt) {
  return 'A real photograph of the same room, a single frame from a live-action feature film shot on a cinema camera. ' +
    String(roomPrompt || '').trim() +
    ' Natural film contrast, subtle grain. Not a render, not CGI, no perfectly regular repeated textures.';
}
