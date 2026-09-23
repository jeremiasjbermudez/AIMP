// A camera on a take, set up in the browser: where it stands, what it looks at, how it
// moves, and how much it shakes - and the camera path that setup produces, one Blender
// matrix per frame. The viewfinder shows exactly this path and Shoot sends exactly this
// path to be staged (48-Blender-Sets "stage" with shot.cameraPath), so what you frame is
// what renders.
//
// Coordinates are Blender's: metres, Z up, the set centred on the origin at floor level.
// A Blender camera looks down its local -Z with local +Y up; so does a three.js camera,
// and blenderToThree() only swaps the world axes (glTF's Y-up export does the same).

export type Vec3 = [number, number, number]
export type Mat4Rows = [number[], number[], number[], number[]]

export type MotionType = 'static' | 'follow' | 'push' | 'pull' | 'dolly' | 'orbit'

export type StageCam = {
  id: string
  name: string
  lensMm: number
  position: Vec3
  motion: {
    type: MotionType
    // push / pull / dolly: metres; orbit: degrees (+ = anticlockwise seen from above)
    amount: number
    startS: number
    endS: number
  }
  handheld: number          // 0 = locked off .. 1 = a loose shoulder-held camera
  directorShotId?: string
}

export const MOTIONS: { value: MotionType; label: string; hint: string }[] = [
  { value: 'static', label: 'Locked off', hint: 'Does not move or turn: framed on where the actor starts' },
  { value: 'follow', label: 'Pan to follow', hint: 'Stays put and turns to keep the actor in frame' },
  { value: 'push', label: 'Push in', hint: 'Moves toward the actor' },
  { value: 'pull', label: 'Pull out', hint: 'Moves away from the actor' },
  { value: 'dolly', label: 'Dolly across', hint: 'Slides sideways, keeping the actor in frame' },
  { value: 'orbit', label: 'Orbit', hint: 'Circles the actor' }
]

export const SENSOR_MM = 36

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
const mul = (a: Vec3, k: number): Vec3 => [a[0] * k, a[1] * k, a[2] * k]
const len = (a: Vec3) => Math.hypot(a[0], a[1], a[2])
const norm = (a: Vec3): Vec3 => { const l = len(a) || 1; return [a[0] / l, a[1] / l, a[2] / l] }
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
const smooth = (t: number) => { const u = Math.max(0, Math.min(1, t)); return u * u * (3 - 2 * u) }

/** Rotate v about a unit axis by an angle (radians). */
function rotate(v: Vec3, axis: Vec3, a: number): Vec3 {
  const c = Math.cos(a), s = Math.sin(a), d = v[0] * axis[0] + v[1] * axis[1] + v[2] * axis[2]
  const k = cross(axis, v)
  return [v[0] * c + k[0] * s + axis[0] * d * (1 - c), v[1] * c + k[1] * s + axis[1] * d * (1 - c), v[2] * c + k[2] * s + axis[2] * d * (1 - c)]
}

/** A Blender camera matrix (rows) at p looking along forward, with roll about it. */
export function lookMatrix(p: Vec3, forward: Vec3, roll = 0): Mat4Rows {
  const f = norm(forward)
  let right = cross(f, [0, 0, 1])
  if (len(right) < 1e-6) right = cross(f, [0, 1, 0])
  right = norm(right)
  let up = cross(right, f)
  if (roll) { right = rotate(right, f, roll); up = rotate(up, f, roll) }
  // Columns are the camera's local axes in the world: X right, Y up, Z back (it looks down -Z).
  return [
    [right[0], up[0], -f[0], p[0]],
    [right[1], up[1], -f[1], p[1]],
    [right[2], up[2], -f[2], p[2]],
    [0, 0, 0, 1]
  ]
}

/**
 * Handheld: slow drift plus small quick corrections, the same on every run for one
 * camera (seeded by its id), so the preview and the render agree.
 */
function shake(id: string, t: number, amount: number) {
  let seed = 0
  for (const ch of id) seed = (seed * 31 + ch.charCodeAt(0)) >>> 0
  const ph = (k: number) => ((seed >>> (k * 3)) % 997) / 997 * Math.PI * 2
  const wave = (k: number, f1: number, f2: number, f3: number) =>
    0.55 * Math.sin(2 * Math.PI * f1 * t + ph(k)) + 0.3 * Math.sin(2 * Math.PI * f2 * t + ph(k + 1)) + 0.15 * Math.sin(2 * Math.PI * f3 * t + ph(k + 2))
  return {
    pos: [0.018 * amount * wave(0, 0.21, 0.63, 1.7), 0.018 * amount * wave(1, 0.17, 0.55, 1.9), 0.012 * amount * wave(2, 0.29, 0.81, 2.3)] as Vec3,
    yaw: (1.4 * Math.PI / 180) * amount * wave(3, 0.23, 0.71, 2.1),
    pitch: (1.0 * Math.PI / 180) * amount * wave(4, 0.19, 0.67, 1.8),
    roll: (0.7 * Math.PI / 180) * amount * wave(5, 0.13, 0.47, 1.3)
  }
}

/**
 * The camera's path over a take: one matrix per frame (frame 1 first).
 * eyes: the performer's eye point on every frame, from the take's manifest.
 */
export function cameraPath(cam: StageCam, eyes: Vec3[], fps = 24): Mat4Rows[] {
  const out: Mat4Rows[] = []
  const e0 = eyes[0]
  const p0 = cam.position
  const look0 = norm(sub(e0, p0))
  const right0 = norm(len(cross(look0, [0, 0, 1])) > 1e-6 ? cross(look0, [0, 0, 1]) : [1, 0, 0])
  const { type, amount, startS, endS } = cam.motion
  for (let i = 0; i < eyes.length; i++) {
    const t = i / fps
    const u = smooth((t - startS) / Math.max(1e-3, endS - startS))
    const e = eyes[i]
    let p: Vec3 = p0
    if (type === 'push') p = add(p0, mul(look0, amount * u))
    else if (type === 'pull') p = add(p0, mul(look0, -amount * u))
    else if (type === 'dolly') p = add(p0, mul(right0, amount * u))
    else if (type === 'orbit') {
      // Around where the actor is at the start, at the camera's height.
      const r = sub(p0, e0)
      const a = (amount * Math.PI / 180) * u
      p = [e0[0] + r[0] * Math.cos(a) - r[1] * Math.sin(a), e0[1] + r[0] * Math.sin(a) + r[1] * Math.cos(a), p0[2]]
    }
    // Locked off keeps its first framing; everything else keeps the actor's eyes in frame.
    let f = type === 'static' ? look0 : norm(sub(e, p))
    let roll = 0
    if (cam.handheld > 0) {
      const h = shake(cam.id, t, cam.handheld)
      p = add(p, h.pos)
      const rightNow = norm(len(cross(f, [0, 0, 1])) > 1e-6 ? cross(f, [0, 0, 1]) : [1, 0, 0])
      f = rotate(f, [0, 0, 1], h.yaw)
      f = rotate(f, rightNow, h.pitch)
      roll = h.roll
    }
    out.push(lookMatrix(p, f, roll))
  }
  return out
}

/** Vertical field of view (degrees) for a lens on the full-frame sensor, at an aspect ratio. */
export function verticalFov(lensMm: number, aspect: number): number {
  return (2 * Math.atan((SENSOR_MM / aspect) / (2 * lensMm)) * 180) / Math.PI
}

/** Horizontal half-angle (radians) of a lens: for drawing its view on the plan. */
export function halfAngle(lensMm: number): number {
  return Math.atan(SENSOR_MM / (2 * lensMm))
}

/** A Blender matrix (rows) as a three.js world matrix (column-major array), Z-up to Y-up. */
export function blenderToThree(m: Mat4Rows): number[] {
  // World basis change: three (x, y, z) = blender (x, z, -y); the camera's local axes are unchanged.
  const c = [[1, 0, 0], [0, 0, 1], [0, -1, 0]]
  const r = [0, 1, 2].map((i) => [0, 1, 2, 3].map((j) => c[i][0] * m[0][j] + c[i][1] * m[1][j] + c[i][2] * m[2][j]))
  return [r[0][0], r[1][0], r[2][0], 0, r[0][1], r[1][1], r[2][1], 0, r[0][2], r[1][2], r[2][2], 0, r[0][3], r[1][3], r[2][3], 1]
}

/** Where a camera starts, and which way it faces at frame 1, on the plan (x, y and a heading). */
export function planPose(cam: StageCam, eyes: Vec3[]): { x: number; y: number; heading: number; path: [number, number][] } {
  const path = cameraPath({ ...cam, handheld: 0 }, eyes)
  const m = path[0]
  return {
    x: m[0][3], y: m[1][3],
    heading: Math.atan2(-m[1][2], -m[0][2]),
    path: path.filter((_, i) => i % 6 === 0).map((q) => [q[0][3], q[1][3]] as [number, number])
  }
}

let counter = 0
/** A new camera across from where the actor starts, looking at them. */
export function newCamera(name: string, eyes: Vec3[], facingDeg: number | null, lensMm = 35): StageCam {
  const e = eyes[0]
  const h = facingDeg == null ? -Math.PI / 2 : (facingDeg * Math.PI) / 180
  // In front of them, slightly to one side, 2 m out, at eye height.
  const a = h + 0.35 * (counter++ % 2 === 0 ? 1 : -1)
  return {
    id: `cam_${Date.now().toString(36)}_${counter}`,
    name,
    lensMm,
    position: [e[0] + Math.cos(a) * 2, e[1] + Math.sin(a) * 2, Math.max(1.2, e[2] - 0.05)],
    motion: { type: 'follow', amount: 0.8, startS: 1, endS: 4 },
    handheld: 0
  }
}
