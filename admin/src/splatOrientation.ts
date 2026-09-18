/**
 * Which way up a splat is loaded, and how to undo it.
 *
 * WHY THIS IS ITS OWN FILE. HY-World picks an up axis per scene and records it
 * beside the .ply, so the viewer turns each splat on load to stand it up on
 * screen. That means the coordinates you fly a camera in are NOT the
 * coordinates the plate renderer works in - they differ by exactly that
 * rotation. A pose carried across without undoing it looks completely valid and
 * points at a different wall, which is the same class of mistake that had the
 * splat viewer upside down for weeks and the survey bearings 60 degrees out.
 *
 * Living in a plain module rather than inside the React component means
 * `_verify_grab_roundtrip.py` can drive the real functions - a rotation that is
 * only exercised by clicking is a rotation nobody checks.
 */
import type { Vec3 } from './cameraIntent'

/** Screen-up in the viewer's own frame: its load rotation is Rx(-90), y down. */
export const VIEW_UP: Vec3 = [0, 0, -1]

/** With no meta file (WorldMirror) the frame is OpenCV first-camera: up is -Y. */
export const OPENCV_UP: Vec3 = [0, -1, 0]

/** The world builder's _yup sibling is the file turned 180 degrees about X. */
export const YUP_ROTATION: number[][] = [[1, 0, 0], [0, -1, 0], [0, 0, -1]]

/** Rotation matrix taking unit vector u onto VIEW_UP (Rodrigues). */
export function rotationTo(uIn: Vec3): number[][] {
  const n = Math.hypot(...uIn) || 1
  const u = uIn.map((x) => x / n) as Vec3
  const t = VIEW_UP
  const v: Vec3 = [u[1] * t[2] - u[2] * t[1], u[2] * t[0] - u[0] * t[2], u[0] * t[1] - u[1] * t[0]]
  const c = u[0] * t[0] + u[1] * t[1] + u[2] * t[2]
  const s = Math.hypot(...v)
  if (s < 1e-9) return c > 0 ? [[1, 0, 0], [0, 1, 0], [0, 0, 1]] : [[1, 0, 0], [0, -1, 0], [0, 0, -1]]
  const K = [[0, -v[2], v[1]], [v[2], 0, -v[0]], [-v[1], v[0], 0]]
  const k = (1 - c) / (s * s)
  return [0, 1, 2].map((i) =>
    [0, 1, 2].map((j) => (i === j ? 1 : 0) + K[i][j] + k * [0, 1, 2].reduce((a, m) => a + K[i][m] * K[m][j], 0))
  )
}

/** Turn a vector by R. */
export function rotate(R: number[][] | null, v: Vec3): Vec3 {
  if (!R) return v
  return [
    R[0][0] * v[0] + R[0][1] * v[1] + R[0][2] * v[2],
    R[1][0] * v[0] + R[1][1] * v[1] + R[1][2] * v[2],
    R[2][0] * v[0] + R[2][1] * v[1] + R[2][2] * v[2]
  ]
}

/**
 * Turn a vector by R inverse - putting a flown pose back in the file's frame.
 *
 * R is a rotation, so its inverse is its transpose. Indexed transposed in place
 * rather than building a second matrix, so there is no other matrix to get the
 * wrong way round.
 */
export function unrotate(R: number[][] | null, v: Vec3): Vec3 {
  if (!R) return v
  return [
    R[0][0] * v[0] + R[1][0] * v[1] + R[2][0] * v[2],
    R[0][1] * v[0] + R[1][1] * v[1] + R[2][1] * v[2],
    R[0][2] * v[0] + R[1][2] * v[1] + R[2][2] * v[2]
  ]
}
