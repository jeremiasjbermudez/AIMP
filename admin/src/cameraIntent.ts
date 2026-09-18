/**
 * Turning a flown camera back into intent.
 *
 * WHY THIS EXISTS. A camera flown in the splat viewer is a position and a
 * direction in one particular reconstruction's coordinates. Storing that is the
 * one thing this whole design refuses to do: every rebuild of a world picks its
 * own origin, axes and scale - the two builds of a location differ by about
 * 5x - so a stored pose silently points somewhere else the next time the room
 * is made, while still looking like a valid camera.
 *
 * So a grabbed pose is not stored. It is INVERTED into the same intent the rest
 * of the system speaks - look at the desk, stand back toward the door, 0.38 of
 * the room, 45mm - which re-resolves against any build.
 *
 * `resolveCamera` below is a line-for-line mirror of `resolve()` in
 * _splat_camera.py, which is what actually renders the plates. It is duplicated
 * rather than called because the inversion has to be checked against the real
 * thing in the browser, before anything is written: `invertPose` re-resolves
 * what it produced and reports how far that lands from the pose that was flown.
 * If the two ever drift apart, the round-trip error says so instead of a plate
 * quietly coming back as a different shot.
 */

export type Vec3 = [number, number, number]

export type Landmark = {
  kind?: string
  direction?: number[]
  wall_distance?: number | null
  bearing_deg?: number
  image?: string
}

/** The measured room, in one build's coordinates. */
export type Plan = {
  center: number[]
  up: number[]
  facing?: number[]
  room_radius: number
  landmarks: Record<string, Landmark>
}

/** What a camera is, in words that survive a rebuild. */
export type Intent = {
  look_at_landmark: string
  from_landmark: string | null
  line_side_landmark: string | null
  distance_frac: number
  offset_frac: number
  eye_height_frac: number
  aim_height_frac: number
  /**
   * How far to one side of the landmark the camera aims.
   *
   * The aim's second degree of freedom. Without it the horizontal bearing of a
   * shot is whatever direction its landmark happens to sit in, so an angle
   * framed between two named things cannot be written down at all.
   */
  aim_side_frac: number
  fov_deg: number
}

/** The survey sweeps the room in steps of this many degrees (SWEEP_STEP). */
const SWEEP_STEP = 20

// ------------------------------------------------------------------ vectors
const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
const mul = (a: Vec3, k: number): Vec3 => [a[0] * k, a[1] * k, a[2] * k]
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const norm = (a: Vec3) => Math.sqrt(dot(a, a))
const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0]
]
const unit = (a: Vec3): Vec3 => {
  const n = norm(a)
  return n > 1e-12 ? mul(a, 1 / n) : [0, 0, 0]
}
const v3 = (a: number[] | undefined, fallback: Vec3 = [0, 0, 0]): Vec3 =>
  Array.isArray(a) && a.length === 3 ? [Number(a[0]), Number(a[1]), Number(a[2])] : fallback

/** Drop the component along `up`, leaving a direction in the floor plane. */
const flat = (a: Vec3, up: Vec3): Vec3 => sub(a, mul(up, dot(up, a)))

/**
 * Solve M x = b for a 3x3 M given as columns. null when M is singular.
 *
 * Cramer's rule: three columns, three determinants, no pivoting to get wrong.
 * The aim solve below is the only 3x3 system here and it is small and
 * well-conditioned whenever it has an answer at all.
 */
function solve3(c0: Vec3, c1: Vec3, c2: Vec3, b: Vec3): Vec3 | null {
  const det = dot(c0, cross(c1, c2))
  // Scaled against the columns, so this means "singular" rather than "small".
  const scale = norm(c0) * norm(c1) * norm(c2)
  if (scale < 1e-12 || Math.abs(det) < 1e-9 * scale) return null
  return [
    dot(b, cross(c1, c2)) / det,
    dot(c0, cross(b, c2)) / det,
    dot(c0, cross(c1, b)) / det
  ]
}

/** Angle between two vectors, in degrees. */
export function angleBetween(a: Vec3, b: Vec3): number {
  const c = dot(unit(a), unit(b))
  return (Math.acos(Math.min(1, Math.max(-1, c))) * 180) / Math.PI
}

/**
 * The room's zero-degree bearing, flattened - its own sense of forward.
 */
function facingOf(plan: Plan, up: Vec3): Vec3 {
  let f = flat(v3(plan.facing, [1, 0, 0]), up)
  let n = norm(f)
  if (n < 1e-6) {
    const axis: Vec3 = Math.abs(up[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0]
    f = cross(up, axis)
    n = norm(f)
  }
  return mul(f, 1 / n)
}

/**
 * Which way is 'to one side of' a landmark, horizontally.
 *
 * Taken from the landmark's own bearing so it means the same thing in any build
 * of the room. A landmark marked as the room's CENTRE has no bearing of its own,
 * so the room's facing stands in.
 */
export function aimSideDirection(
  plan: Plan, up: Vec3, marks: Record<string, Landmark>, look: string
): Vec3 {
  const m = marks[look] || {}
  let d: Vec3 | null = null
  if (m.kind !== 'center' && m.direction) {
    const flatD = flat(v3(m.direction), up)
    if (norm(flatD) >= 1e-6) d = flatD
  }
  if (!d) d = facingOf(plan, up)
  const side = cross(up, d)
  const n = norm(side)
  return n < 1e-9 ? [0, 0, 0] : mul(side, 1 / n)
}

/**
 * Which way the camera stands back from its target.
 *
 * Shared by resolveCamera and invertPose deliberately: the fallbacks here are
 * where this went wrong. A camera aimed at a landmark marked as the room's
 * CENTRE has no horizontal direction to stand back along - center minus target
 * points straight down the up axis - and the old code divided that by ~zero and
 * put the camera on floating-point noise. Two copies of a chain like that drift
 * apart and the inversion starts returning a different shot than it was given.
 */
function standBackDirection(
  plan: Plan, up: Vec3, center: Vec3, marks: Record<string, Landmark>,
  look: string, target: Vec3, from: string | null
): Vec3 {
  const directionOf = (name: string): Vec3 => v3(marks[name]?.direction)
  let back: Vec3
  if (from && marks[from]) {
    back = directionOf(from)
  } else {
    back = sub(center, target)
    const n = norm(back)
    back = n > 1e-9 ? mul(back, 1 / n) : mul(directionOf(look), -1)
  }
  back = flat(back, up)
  let n = norm(back)
  if (n < 1e-6) {
    // The room's facing bearing is its own zero degrees: definite, and the
    // same every time this is asked.
    back = flat(v3(plan.facing, [1, 0, 0]), up)
    n = norm(back)
  }
  if (n < 1e-6) {
    // Even facing lies along up - a malformed plan. Any horizontal direction
    // will do, so long as it is the same one every time.
    const axis: Vec3 = Math.abs(up[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0]
    back = cross(up, axis)
    n = norm(back)
  }
  // No epsilon in this divide. One here left `back` a billionth short of unit
  // length, which pushed sideOfLine's degenerate case just over its own guard.
  return mul(back, 1 / n)
}

/**
 * Which way is sideways, for the offset that keeps people on one side of frame.
 *
 * Shared, for the same reason as standBackDirection. Naming the same landmark
 * for both "looking at" and "side of the line" is an easy thing to do and makes
 * this collapse to zero; falling back to the room's own perpendicular keeps the
 * offset the shot asked for instead of quietly dropping it.
 */
function sideOfLine(
  up: Vec3, marks: Record<string, Landmark>, back: Vec3, lineSide: string | null
): Vec3 {
  if (lineSide && marks[lineSide]) {
    const d = v3(marks[lineSide]?.direction)
    const side = sub(d, mul(back, dot(d, back)))
    if (norm(side) >= 1e-6) return side
  }
  return cross(up, back)
}

// ------------------------------------------------------------------ forward
/**
 * Resolve intent to a pose. Mirrors `resolve()` in _splat_camera.py exactly.
 *
 * Kept in step with that function by `_verify_camera_intent.py`, which drives
 * random intents through both and compares, rather than by anybody remembering
 * to edit two files.
 */
export function resolveCamera(camera: Intent, plan: Plan): { position: Vec3; target: Vec3; up: Vec3 } {
  const center = v3(plan.center)
  const up = unit(v3(plan.up, [0, 0, 1]))
  const radius = Number(plan.room_radius)
  const marks = plan.landmarks || {}

  const directionOf = (name: string): Vec3 => v3(marks[name]?.direction)

  const look = camera.look_at_landmark
  const targetMark = marks[look] || {}
  // A 'center' landmark is a position in the room; a 'wall' one is a direction.
  let base: Vec3
  if (targetMark.kind === 'center') {
    base = center
  } else {
    const wall = targetMark.wall_distance == null ? radius : Number(targetMark.wall_distance)
    base = add(center, mul(directionOf(look), wall))
  }

  // WHERE IT LOOKS: the aim's two axes, beside and above the landmark.
  const aim = Number(camera.aim_height_frac)
  const aimSideFrac = Number(camera.aim_side_frac) || 0
  const aimSide = aimSideDirection(plan, up, marks, look)
  const target = add(add(base, mul(up, aim * radius)), mul(aimSide, aimSideFrac * radius))

  // Stand back from the LANDMARK - never from the aimed point, or looking
  // further to one side would walk the camera.
  const back = standBackDirection(plan, up, center, marks, look, base, camera.from_landmark)

  // WHERE IT STANDS. Nothing below reads the aim at all.
  let pos = add(base, mul(back, Number(camera.distance_frac) * radius))

  const off = Number(camera.offset_frac)
  if (Math.abs(off) > 1e-9) {
    const side = sideOfLine(up, marks, back, camera.line_side_landmark)
    const n = norm(side)
    if (n > 1e-9) pos = add(pos, mul(mul(side, 1 / n), off * radius))
  }

  pos = add(pos, mul(up, Number(camera.eye_height_frac) * radius))
  return { position: pos, target, up }
}

/**
 * Arc the camera up over the subject, or down under it.
 *
 * The other half of orbit. Going round is a turn about the room's up axis;
 * this is the turn in the vertical plane, at a constant distance from the
 * aimed point - so the camera rises over a desk rather than backing away from
 * it, which is what raising the pedestal alone does.
 *
 * Stored as horizontal distance and height, so this is polar to cylindrical
 * and back: take the current radius and elevation about the aimed point, move
 * the elevation, put them back. Stopped short of the poles, where the
 * horizontal distance collapses and a camera directly overhead has no bearing
 * left to preserve.
 */
export function elevateIntent(camera: Intent, deg: number): Intent {
  const r = Math.hypot(camera.distance_frac, camera.offset_frac)
  const h = camera.eye_height_frac - camera.aim_height_frac
  const R = Math.hypot(r, h)
  if (R < 1e-6) return camera
  const limit = (85 * Math.PI) / 180
  const phi = Math.min(limit, Math.max(-limit, Math.atan2(h, r) + (deg * Math.PI) / 180))
  const r2 = R * Math.cos(phi)
  const h2 = R * Math.sin(phi)
  // Keep the bearing; only the distance along it changes.
  const k = r > 1e-6 ? r2 / r : 0
  return {
    ...camera,
    distance_frac: r > 1e-6 ? camera.distance_frac * k : r2,
    offset_frac: r > 1e-6 ? camera.offset_frac * k : 0,
    eye_height_frac: camera.aim_height_frac + h2
  }
}

/** The camera's current elevation above the point it aims at, in degrees. */
export function elevationOf(camera: Intent): number {
  const r = Math.hypot(camera.distance_frac, camera.offset_frac)
  const h = camera.eye_height_frac - camera.aim_height_frac
  if (Math.hypot(r, h) < 1e-6) return 0
  return (Math.atan2(h, r) * 180) / Math.PI
}

/**
 * Slide the camera without turning it - a truck and a pedestal.
 *
 * Orbit arcs around the subject; this moves the camera bodily, so the view
 * translates instead of swinging. To do that WITHOUT any rotation creeping in,
 * the aimed point has to move by the very same vector as the camera.
 *
 * That constrains which way sideways can be. The aimed point may only move
 * along the landmark's own side axis (that is the one horizontal freedom the
 * aim has), so translation happens along THAT axis, and the camera's share of
 * it is decomposed onto the two directions its position is stored in. Both end
 * up displaced by an identical vector, so the move is exact rather than nearly
 * right - vertical likewise, since camera and aim both measure height along the
 * room's up.
 *
 * `sideFrac` and `upFrac` are fractions of the room radius, like everything
 * else here.
 */
export function translateIntent(camera: Intent, plan: Plan, sideFrac: number, upFrac: number): Intent {
  const center = v3(plan.center)
  const up = unit(v3(plan.up, [0, 0, 1]))
  const radius = Number(plan.room_radius)
  const marks = plan.landmarks || {}
  const look = camera.look_at_landmark

  const m = marks[look] || {}
  const base: Vec3 =
    m.kind === 'center'
      ? center
      : add(center, mul(v3(m.direction), m.wall_distance == null ? radius : Number(m.wall_distance)))

  const back = standBackDirection(plan, up, center, marks, look, base, camera.from_landmark)
  const side = unit(sideOfLine(up, marks, back, camera.line_side_landmark))
  const aimSide = aimSideDirection(plan, up, marks, look)

  return {
    ...camera,
    // The camera's share of the same displacement, in the directions its
    // position is actually stored in.
    distance_frac: camera.distance_frac + sideFrac * dot(aimSide, back),
    offset_frac: camera.offset_frac + sideFrac * dot(aimSide, side),
    aim_side_frac: camera.aim_side_frac + sideFrac,
    // Vertical needs no decomposing: both are measured along up already.
    eye_height_frac: camera.eye_height_frac + upFrac,
    aim_height_frac: camera.aim_height_frac + upFrac
  }
}

// ------------------------------------------------------------------ inverse
export type GrabQuality = {
  /** How far the re-resolved camera lands from the pose that was flown. */
  positionError: number
  /** The same, as a fraction of the room's radius - the number that travels. */
  positionErrorFrac: number
  /** How far the re-resolved camera points from where the flown one pointed. */
  aimErrorDeg: number
  /** How far the aim ray passes from the chosen landmark's own axis. */
  landmarkMissFrac: number
  /** Where the camera looks, as a bearing in the survey's own degrees. */
  aimBearingDeg: number
  /** The survey sweep view that shows what it is looking at, for naming it. */
  sweepBearingDeg: number
  /** True when this is close enough to write without lying about the angle. */
  faithful: boolean
  notes: string[]
}

const round = (x: number, places: number) => {
  const f = Math.pow(10, places)
  return Math.round(x * f) / f
}

/**
 * A flown pose -> the intent that reproduces it.
 *
 * `position` and `forward` must already be in the SPLAT'S OWN coordinates, not
 * the viewer's - SplatViewer rotates the gaussians on load so the room stands
 * up on screen, and a pose taken in that rotated frame is 90 degrees or more
 * from the frame the plate renderer works in. SplatViewer undoes that before
 * calling here, which is the only place that rotation is known.
 *
 * `base` supplies the fields that are not derivable from a pose (the lens, and
 * the side of the line, which is a continuity decision rather than a geometric
 * one).
 */
export function invertPose(
  position: Vec3,
  forward: Vec3,
  plan: Plan,
  base: Intent
): { intent: Intent; quality: GrabQuality } {
  const center = v3(plan.center)
  const up = unit(v3(plan.up, [0, 0, 1]))
  const radius = Number(plan.room_radius)
  const marks = plan.landmarks || {}
  const names = Object.keys(marks)
  const notes: string[] = []

  const P = position
  const f = unit(forward)
  const directionOf = (name: string): Vec3 => v3(marks[name]?.direction)

  /** Where a landmark sits, before any aim height is added. */
  const basePoint = (name: string): Vec3 => {
    const m = marks[name] || {}
    if (m.kind === 'center') return center
    const wall = m.wall_distance == null ? radius : Number(m.wall_distance)
    return add(center, mul(directionOf(name), wall))
  }

  // --- 1. what is it looking at? -------------------------------------------
  //
  // resolve() aims at a point directly above a landmark: target = T0 + up * h.
  // So the right landmark is the one whose vertical axis the aim ray passes
  // closest to. For each, least-squares solve t*f - up*h = T0 - P for the ray
  // parameter t and the height h; the residual is the miss distance, which is
  // both the thing to minimise and an honest quality signal.
  let look = ''
  let aimHeight = 0
  let aimSide = 0
  let bestMiss = Infinity
  let bestAimDeg = Infinity
  let bestNudge = Infinity
  const upDotF = dot(up, f)

  if (names.length === 0) {
    return {
      intent: base,
      quality: {
        positionError: NaN, positionErrorFrac: NaN, aimErrorDeg: NaN, landmarkMissFrac: NaN,
        aimBearingDeg: NaN, sweepBearingDeg: NaN,
        faithful: false,
        notes: ['This floor plan has no landmarks yet — name them in the survey above first.']
      }
    }
  }

  if (Math.abs(upDotF) > 0.999999) {
    // Pointing straight up or straight down: every landmark axis is equally
    // parallel to the ray and the solve is meaningless.
    notes.push('The camera is pointing almost straight up or down, which no landmark aim can express.')
  }

  // Which landmark describes this aim, and how far above and beside it.
  //
  // The aim is T0 + up * h + side * s, and it must land on the ray P + t * f:
  //
  //     t * f  -  up * h  -  side * s  =  T0 - P
  //
  // Three unknowns, three equations - so with both aim axes there is usually an
  // EXACT answer, where before only the height could move and the best any
  // landmark could do was about a degree.
  //
  // Several landmarks can describe the same angle exactly, so the tie-break is
  // the smallest sideways nudge: "the desk, a little left" says what the shot is
  // about, where "the window, hugely right" describes the same frame and tells
  // you nothing. Landmarks that cannot solve at all fall back to aiming as near
  // as a height alone allows, which is what the old code did for every case.
  for (const name of names) {
    const T0 = basePoint(name)
    const a = sub(T0, P)
    const side = aimSideDirection(plan, up, marks, name)

    const exact = norm(side) > 1e-9
      ? solve3(f, mul(up, -1), mul(side, -1), a)
      : null

    if (exact && exact[0] > 1e-9) {
      const [, h, sFrac] = exact
      const nudge = Math.abs(sFrac)
      // An exact answer always beats an approximate one.
      if (bestAimDeg > 1e-9 || nudge < bestNudge) {
        bestAimDeg = 0
        bestNudge = nudge
        look = name
        aimHeight = h
        aimSide = sFrac
        bestMiss = 0
      }
      continue
    }
    if (bestAimDeg <= 1e-9) continue // an exact answer is already in hand

    // No exact answer for this landmark: the ray runs parallel to the plane
    // beside it. Fall back to the nearest a height alone can get.
    const A = dot(a, f)
    const B = upDotF
    const C = dot(a, a)
    const D = dot(a, up)
    const denom = B * D - A
    if (Math.abs(denom) < 1e-12) continue
    const h = (A * D - B * C) / denom
    const aimVec = add(a, mul(up, h))
    const along = dot(aimVec, f)
    if (along <= 1e-9) continue // behind the camera
    const deg = angleBetween(aimVec, f)
    if (deg < bestAimDeg) {
      bestAimDeg = deg
      look = name
      aimHeight = h
      aimSide = 0
      bestMiss = norm(sub(aimVec, mul(f, along)))
    }
  }

  if (!look) {
    // Nothing in front of the camera. Fall back to whatever the shot already
    // aimed at rather than inventing a landmark.
    look = base.look_at_landmark && marks[base.look_at_landmark] ? base.look_at_landmark : names[0]
    aimHeight = base.aim_height_frac * radius
    aimSide = base.aim_side_frac * radius
    bestMiss = Infinity
    bestAimDeg = Infinity
    notes.push('Nothing on the floor plan lies in front of this camera, so what it looks at could not be worked out.')
  }

  // --- 2. heights, and the walk back ---------------------------------------
  const T0 = basePoint(look)
  const v = sub(P, T0)
  const eyeHeight = dot(up, v)
  const hv = flat(v, up)
  const hLen = norm(hv)

  // The same direction resolve() would pick with no from_landmark - asked of
  // the shared function rather than recomputed, and asked about the landmark
  // itself, which is what resolve() measures the way back from.
  const backNull = standBackDirection(plan, up, center, marks, look, T0, null)

  // --- 3. which way did it stand back? -------------------------------------
  //
  // Whichever candidate the camera actually lies along. Anything with the
  // camera behind it is not a description of this shot at all.
  type Cand = { from: string | null; back: Vec3; along: number }
  const cands: Cand[] = [{ from: null, back: backNull, along: dot(hv, backNull) }]
  for (const name of names) {
    const b = flat(directionOf(name), up)
    if (norm(b) < 1e-9) continue
    const bu = unit(b)
    cands.push({ from: name, back: bu, along: dot(hv, bu) })
  }

  // Closest in angle among those the camera stands on the near side of; the
  // straight-back fallback only when no landmark does better, so a grab does
  // not gratuitously rewrite from_landmark.
  let chosen = cands[0]
  let bestCos = -Infinity
  for (const c of cands) {
    if (c.along <= 0) continue
    const cos = hLen > 1e-9 ? c.along / hLen : 1
    if (cos > bestCos + 1e-9) {
      bestCos = cos
      chosen = c
    }
  }
  if (bestCos === -Infinity) {
    notes.push('This camera stands on the far side of what it is looking at, which intent cannot express.')
    chosen = cands[0]
  }

  const back = chosen.back
  const distance = dot(hv, back)
  const residual = sub(hv, mul(back, distance))

  // --- 4. the sideways nudge ------------------------------------------------
  //
  // `residual` is horizontal and perpendicular to `back`, and so is every side
  // vector resolve() can build, so the two are always parallel - the only
  // question is the sign. That means the shot's existing line side survives a
  // grab instead of being wiped, which is the point of it.
  // Asked of the shared function, so this is the very direction resolve() will
  // use when it renders - including where the named landmark cannot set a side
  // and the room's perpendicular stands in.
  const lineSide = base.line_side_landmark
  const side = sideOfLine(up, marks, back, lineSide)
  const sideN = norm(side)
  const offset = sideN > 1e-9 ? dot(residual, mul(side, 1 / sideN)) : 0

  // --- 5. the lens ----------------------------------------------------------
  //
  // Deliberately NOT taken from the viewer. Its fx is a pixel focal length
  // against the canvas width, so a field of view read back from it describes
  // how wide the browser panel is. The shot's own lens is pushed INTO the
  // viewer instead, so the framing on screen is the framing that renders.
  const intent: Intent = {
    look_at_landmark: look,
    from_landmark: chosen.from,
    line_side_landmark: lineSide,
    // Rounded before the round-trip check, so the error reported is the error
    // of what actually gets written, not of an exact value that is then lost.
    //
    // Six places, not four. Four costs up to a tenth of a degree of aim on a
    // tight framing - about six pixels across a plate - because a fraction of
    // the room is a large step when the camera is a hand-span from its subject.
    distance_frac: round(distance / radius, 6),
    offset_frac: round(offset / radius, 6),
    eye_height_frac: round(eyeHeight / radius, 6),
    aim_height_frac: round(aimHeight / radius, 6),
    aim_side_frac: round(aimSide / radius, 6),
    fov_deg: base.fov_deg
  }

  // --- 6. where is it pointing, in the survey's own terms? ------------------
  //
  // So a miss can be acted on. The survey grid is labelled in bearings from the
  // room's facing direction in 20 degree steps, so this names the very picture
  // to look at and put a name to.
  const facingFlat = flat(v3(plan.facing, [1, 0, 0]), up)
  const aimFlat = flat(f, up)
  let aimBearingDeg = NaN
  if (norm(facingFlat) > 1e-9 && norm(aimFlat) > 1e-9) {
    const fu = unit(facingFlat)
    const au = unit(aimFlat)
    // Same turn as the survey's own rotate_about(facing, up, deg).
    const deg = (Math.atan2(dot(up, cross(fu, au)), dot(fu, au)) * 180) / Math.PI
    aimBearingDeg = (deg + 360) % 360
  }
  const sweepBearingDeg = Number.isNaN(aimBearingDeg)
    ? NaN
    : (Math.round(aimBearingDeg / SWEEP_STEP) * SWEEP_STEP) % 360

  // --- 7. does it reproduce? ------------------------------------------------
  const check = resolveCamera(intent, plan)
  const positionError = norm(sub(check.position, P))
  const aimErrorDeg = angleBetween(sub(check.target, check.position), f)
  const positionErrorFrac = radius > 1e-9 ? positionError / radius : NaN
  const landmarkMissFrac = radius > 1e-9 ? bestMiss / radius : NaN

  // A hundredth of the room and a quarter of a degree: below what a plate at
  // this resolution could show, and far below what re-surveying the room moves
  // things by anyway.
  const faithful = positionErrorFrac <= 0.01 && aimErrorDeg <= 0.25 && notes.length === 0

  if (Math.abs(intent.distance_frac) < 0.02) {
    notes.push('This camera is almost on top of what it is looking at; the plate will be mostly one surface.')
  }
  if (aimErrorDeg > 0.25) {
    // The actionable version. Intent aims at a NAMED thing, so an angle looking
    // at something unnamed cannot be written down - and the answer is to name
    // it, which takes ten seconds and makes every future shot of it easier.
    // With both aim axes this is rare - it means the aim runs parallel to the
    // plane beside every landmark, so no named thing can describe it at all.
    const where = Number.isNaN(sweepBearingDeg) ? '' : ` It is looking along bearing ${Math.round(aimBearingDeg)}°, so open the survey above, find the ${sweepBearingDeg}° view, and give what you see there a name.`
    notes.push(
      `This camera is aimed ${aimErrorDeg.toFixed(1)}° away from "${look}", and no named landmark can describe where it points.${where} Then take the angle again.`
    )
  }

  return {
    intent,
    quality: {
      positionError, positionErrorFrac, aimErrorDeg, landmarkMissFrac,
      aimBearingDeg, sweepBearingDeg, faithful, notes
    }
  }
}
