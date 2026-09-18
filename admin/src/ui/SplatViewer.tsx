import { useEffect, useRef, useState } from 'react'
import { comfyViewUrl } from '../insforge'
import type { Vec3 } from '../cameraIntent'
import { OPENCV_UP, YUP_ROTATION, rotationTo, rotate, unrotate } from '../splatOrientation'

// Embeds ComfyUI's gaussian-splat room viewer and catches its screenshot.
//
// The extension was written to be hosted in an iframe and already speaks a
// postMessage protocol, so nothing here reaches into its internals:
//   host -> viewer   { type: 'LOAD_MESH_DATA', data: ArrayBuffer, filename, format }
//   viewer -> host   { type: 'SCREENSHOT', image: <png data URL> }
// The .ply bytes are transferred rather than copied, since these run to
// hundreds of megabytes.
// Absolute, against ComfyUI. As a root-relative path this resolved against the
// admin app's own origin (5184), where Vite's SPA fallback served index.html -
// so the frame came up blank white and the splat never appeared.
const VIEWER_SRC =
  `${import.meta.env.VITE_COMFY_URL}/extensions/comfyui-gsplat-room-viewer/viewer_room.html`

// ply_path is stored as an ABSOLUTE Windows path (C:/ComfyUI2/output/...), not
// the ComfyUI-relative form the /view endpoint takes. Passing it straight to
// comfyViewUrl produced type=C:, which fetches nothing. Everything up to and
// including the output/ or input/ segment is trimmed, and the folder it came
// from becomes the type.
function toViewPath(raw: string): string {
  const norm = String(raw).split(String.fromCharCode(92)).join('/')
  const m = /(?:^|\/)(output|input|temp)\/(.+)$/i.exec(norm)
  if (m) return `${m[1].toLowerCase()}/${m[2]}`
  return norm.replace(/^\//, '')
}

// ---------------------------------------------------------------- orientation
//
// HY-World's world-generation output has no fixed up axis: the pipeline picks
// one per scene and records it as up_direction in position_meta_info.json next
// to the .ply (island came out +Z up, a room -Z up). A fixed flip therefore
// rights some splats and capsizes others. Instead each splat is rotated on load
// so its own up lands on file -Z, which is what this viewer shows as screen-up
// (its load rotation is Rx(-90) with screen y down; checked against the
// world-builder _yup copies, which display upright). Positions, normals and the
// per-splat quaternions all turn together, so the ellipsoids stay oriented.
// With no meta file (WorldMirror reconstructions) the frame is OpenCV
// first-camera, where up is -Y.
/** (w, x, y, z) of a rotation matrix. */
function quatOf(R: number[][]): [number, number, number, number] {
  const tr = R[0][0] + R[1][1] + R[2][2]
  if (tr > 0) {
    const s = 0.5 / Math.sqrt(tr + 1)
    return [0.25 / s, (R[2][1] - R[1][2]) * s, (R[0][2] - R[2][0]) * s, (R[1][0] - R[0][1]) * s]
  }
  if (R[0][0] > R[1][1] && R[0][0] > R[2][2]) {
    const s = 2 * Math.sqrt(1 + R[0][0] - R[1][1] - R[2][2])
    return [(R[2][1] - R[1][2]) / s, 0.25 * s, (R[0][1] + R[1][0]) / s, (R[0][2] + R[2][0]) / s]
  }
  if (R[1][1] > R[2][2]) {
    const s = 2 * Math.sqrt(1 + R[1][1] - R[0][0] - R[2][2])
    return [(R[0][2] - R[2][0]) / s, (R[0][1] + R[1][0]) / s, 0.25 * s, (R[1][2] + R[2][1]) / s]
  }
  const s = 2 * Math.sqrt(1 + R[2][2] - R[0][0] - R[1][1])
  return [(R[1][0] - R[0][1]) / s, (R[0][2] + R[2][0]) / s, (R[1][2] + R[2][1]) / s, 0.25 * s]
}

const PLY_SIZES: Record<string, number> = {
  char: 1, uchar: 1, int8: 1, uint8: 1, short: 2, ushort: 2, int16: 2, uint16: 2,
  int: 4, uint: 4, int32: 4, uint32: 4, float: 4, float32: 4, double: 8, float64: 8
}

/** Rotate a binary little-endian gaussian .ply in place. Returns false if the format is not one it can safely edit. */
function orientPly(buf: ArrayBuffer, R: number[][]): boolean {
  const head = new TextDecoder('latin1').decode(new Uint8Array(buf, 0, Math.min(buf.byteLength, 65536)))
  const endAt = head.indexOf('end_header')
  if (endAt < 0 || !/format binary_little_endian/.test(head)) return false
  const dataStart = head.indexOf('\n', endAt) + 1
  const lines = head.slice(0, endAt).split('\n').map((l) => l.trim())
  let count = 0
  let inVertex = false
  let seenElement = false
  let stride = 0
  const props: Record<string, number> = {}
  for (const l of lines) {
    const p = l.split(/\s+/)
    if (p[0] === 'element') {
      // Only a leading vertex element can be addressed by offset alone.
      if (inVertex) break
      if (p[1] !== 'vertex' || seenElement) return false
      seenElement = true
      inVertex = true
      count = Number(p[2])
    } else if (p[0] === 'property' && inVertex) {
      if (p[1] === 'list' || !(p[1] in PLY_SIZES)) return false
      props[p[2]] = p[1] === 'float' || p[1] === 'float32' ? stride : -1
      stride += PLY_SIZES[p[1]]
    }
  }
  const off = (k: string) => (k in props ? props[k] : -2)
  const [ox, oy, oz] = [off('x'), off('y'), off('z')]
  if (ox < 0 || oy < 0 || oz < 0 || !count || dataStart + count * stride > buf.byteLength) return false
  const normals = ['nx', 'ny', 'nz'].map(off)
  const quats = ['rot_0', 'rot_1', 'rot_2', 'rot_3'].map(off)
  const doN = normals.every((o) => o >= 0)
  const doQ = quats.every((o) => o >= 0)
  const [qw, qx, qy, qz] = quatOf(R)
  const dv = new DataView(buf)
  const turn = (b: number, o: number[]) => {
    const a = dv.getFloat32(b + o[0], true), c = dv.getFloat32(b + o[1], true), d = dv.getFloat32(b + o[2], true)
    dv.setFloat32(b + o[0], R[0][0] * a + R[0][1] * c + R[0][2] * d, true)
    dv.setFloat32(b + o[1], R[1][0] * a + R[1][1] * c + R[1][2] * d, true)
    dv.setFloat32(b + o[2], R[2][0] * a + R[2][1] * c + R[2][2] * d, true)
  }
  for (let i = 0; i < count; i++) {
    const b = dataStart + i * stride
    turn(b, [ox, oy, oz])
    if (doN) turn(b, normals)
    if (doQ) {
      // 3DGS stores rot_0..3 as (w, x, y, z); the new orientation is qR * q.
      const w = dv.getFloat32(b + quats[0], true), x = dv.getFloat32(b + quats[1], true)
      const y = dv.getFloat32(b + quats[2], true), z = dv.getFloat32(b + quats[3], true)
      dv.setFloat32(b + quats[0], qw * w - qx * x - qy * y - qz * z, true)
      dv.setFloat32(b + quats[1], qw * x + qx * w + qy * z - qz * y, true)
      dv.setFloat32(b + quats[2], qw * y - qx * z + qy * w + qz * x, true)
      dv.setFloat32(b + quats[3], qw * z + qx * y - qy * x + qz * w, true)
    }
  }
  return true
}

/** The scene's own up axis, from position_meta_info.json beside the .ply. */
async function readUp(viewPath: string): Promise<{ up: Vec3; from: 'meta' | 'opencv' }> {
  const dir = viewPath.slice(0, viewPath.lastIndexOf('/'))
  try {
    const res = await fetch(comfyViewUrl(`${dir}/position_meta_info.json`))
    if (res.ok) {
      const up = (await res.json())?.up_direction
      if (Array.isArray(up) && up.length === 3 && up.every((x: unknown) => typeof x === 'number')) {
        return { up: up as Vec3, from: 'meta' }
      }
    }
  } catch {
    // No meta file - fall through to the reconstruction convention.
  }
  return { up: OPENCV_UP, from: 'opencv' }
}

/** A camera flown in the viewer, already back in the SPLAT'S own coordinates. */
export type GrabbedPose = {
  position: Vec3
  forward: Vec3
  /** What the viewer was actually framing, for reporting - not for storing. */
  fovDeg: number
  /** The viewer's roll control. A look-at plate cannot reproduce roll. */
  tiltDeg: number
}

function dataUrlToFile(dataUrl: string, name: string): File {
  const [head, b64] = dataUrl.split(',')
  const mime = /:(.*?);/.exec(head)?.[1] ?? 'image/png'
  const bin = atob(b64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return new File([bytes], name, { type: mime })
}

export function SplatViewer({
  plyPath,
  label,
  onSnapshot,
  onClose,
  orient,
  up,
  fovDeg,
  onGrab,
  grabLabel = 'Use this angle',
  status,
  pose
}: {
  plyPath: string
  label: string
  onSnapshot: (file: File, previewUrl: string) => void
  onClose: () => void
  /** 'scene-up': rotate on load by the splat's own up axis (HY-World). Omitted: the _yup-copy behaviour. */
  orient?: 'scene-up'
  /**
   * The scene's up axis, when the caller already knows it.
   *
   * The floor plan a camera resolves against stores the up it was measured
   * with. Passing that here instead of re-reading position_meta_info.json means
   * the viewer and the plate renderer cannot end up disagreeing about which way
   * is up for the same room - they are given the same number.
   */
  up?: number[]
  /**
   * Pin the viewer to a real horizontal field of view.
   *
   * Without it the viewer's fx is fixed and its field of view is whatever the
   * panel width makes it, so what is framed here is not what renders.
   */
  fovDeg?: number
  /**
   * Hand back the camera as it is right now, in the splat's OWN coordinates.
   *
   * The un-rotation happens here because here is the only place that knows what
   * rotation was applied on load. A pose taken in the viewer's frame and used as
   * if it were the file's frame looks entirely valid and points at a different
   * wall - the same class of mistake as the upside-down splat.
   */
  onGrab?: (pose: GrabbedPose) => void
  grabLabel?: string
  /**
   * Drive the viewer FROM the shot, in the splat's own coordinates.
   *
   * The same pose the plate renderer resolves, pushed through the same rotation
   * the gaussians were loaded with - so the viewer shows the shot as it is,
   * live, and a slider moves the room instead of queueing a render. It is also
   * the other half of the grab: setting a pose and reading it back must return
   * what was set, which is a thing that can be checked by looking.
   */
  pose?: { position: Vec3; target: Vec3 }
  /**
   * What happened to the last angle taken, shown in the bar.
   *
   * The viewer stays open across grabs - reloading a 130 MB splat to adjust an
   * angle by a few degrees is not a workflow - so the result has to be readable
   * without closing it.
   */
  status?: string
}) {
  const frameRef = useRef<HTMLIFrameElement | null>(null)
  // The rotation applied to the gaussians on load, kept so a grabbed pose can
  // be put back into the file's own frame. null means none was applied.
  const loadRotation = useRef<number[][] | null>(null)
  const [state, setState] = useState<'loading' | 'handed' | 'error'>('loading')
  const [size, setSize] = useState(0)
  const [flipped, setFlipped] = useState(true)
  const [detail, setDetail] = useState('')

  useEffect(() => {
    function onMessage(e: MessageEvent) {
      const d = e.data
      if (!d || typeof d !== 'object') return
      if (d.type === 'SCREENSHOT' && typeof d.image === 'string') {
        const stamp = new Date().toISOString().replace(/[:.]/g, '-')
        onSnapshot(dataUrlToFile(d.image, `splat-${stamp}.png`), d.image)
      } else if (d.type === 'CAMERA' && Array.isArray(d.position) && Array.isArray(d.forward)) {
        if (!onGrab) return
        // Ask for the frame as well, so what was framed can be put beside what
        // the plate renderer makes of it. Two pictures settle an argument about
        // coordinates that no amount of reading the numbers will.
        frameRef.current?.contentWindow?.postMessage({ type: 'TAKE_SCREENSHOT' }, '*')
        const R = loadRotation.current
        onGrab({
          position: unrotate(R, [Number(d.position[0]), Number(d.position[1]), Number(d.position[2])]),
          forward: unrotate(R, [Number(d.forward[0]), Number(d.forward[1]), Number(d.forward[2])]),
          fovDeg: Number(d.fovDeg),
          tiltDeg: Number(d.tiltDeg) || 0
        })
      } else if (d.type === 'MESH_ERROR') {
        setState('error')
        setDetail(String(d.error || 'The viewer could not load this splat.'))
      }
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [onSnapshot, onGrab])

  // The pipeline authors splats in OpenCV/COLMAP convention (Y-down) while this
  // viewer expects Y-up, so the raw .ply renders upside down. The world builder
  // already writes a corrected sibling next to it - <name>_yup.ply - with both
  // positions AND per-splat orientation quaternions rotated 180 degrees about
  // X. That file is preferred whenever it exists.
  //
  // A camera tilt would look right but leave every ellipsoid pointing the wrong
  // way, so it is not an acceptable substitute.
  async function pickPly(): Promise<{ view: string; flipped: boolean }> {
    const base = toViewPath(plyPath)
    const yup = base.toLowerCase().endsWith('.ply') ? `${base.slice(0, -4)}_yup.ply` : `${base}_yup.ply`
    try {
      const head = await fetch(comfyViewUrl(yup), { method: 'HEAD' })
      if (head.ok) return { view: yup, flipped: true }
    } catch {
      // Fall through to the original; a failed probe is not fatal.
    }
    return { view: base, flipped: false }
  }

  // Fetch the .ply and hand it to the viewer once the frame is up. The viewer
  // has no way to fetch by path itself - it only accepts bytes.
  //
  // Progress is reported from the download, because the viewer sends no
  // "loaded" message of any kind: it only ever posts SCREENSHOT and COPY_IMAGE.
  // Claiming "ready" the moment the bytes are handed over was a lie - these
  // splats run to 130 MB and the viewer is still parsing long after.
  async function pushMesh() {
    try {
      const chosen = orient ? { view: toViewPath(plyPath), flipped: true } : await pickPly()
      setFlipped(chosen.flipped)
      const res = await fetch(comfyViewUrl(chosen.view))
      if (!res.ok) throw new Error(`Could not read the splat (HTTP ${res.status})`)

      const total = Number(res.headers.get('content-length')) || 0
      const mb = (n: number) => `${(n / 1048576).toFixed(0)} MB`
      let buf: ArrayBuffer
      if (res.body && total) {
        const reader = res.body.getReader()
        const chunks: Uint8Array[] = []
        let got = 0
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          chunks.push(value)
          got += value.length
          setDetail(`Downloading ${mb(got)} of ${mb(total)}…`)
        }
        const joined = new Uint8Array(got)
        let at = 0
        for (const c of chunks) {
          joined.set(c, at)
          at += c.length
        }
        buf = joined.buffer
      } else {
        buf = await res.arrayBuffer()
      }

      loadRotation.current = null
      if (orient) {
        setDetail('Turning the splat upright…')
        // The caller's up wins: it is the one the floor plan was measured with,
        // and the plates are rendered against that same plan.
        const sceneUp = up && up.length === 3 ? (up as Vec3) : (await readUp(chosen.view)).up
        const R = rotationTo(sceneUp)
        if (orientPly(buf, R)) {
          loadRotation.current = R
        } else {
          setFlipped(false)
        }
      } else if (chosen.flipped) {
        // The _yup sibling is the file turned 180 degrees about X, so a pose
        // taken here is in that turned frame.
        loadRotation.current = YUP_ROTATION
      }

      const win = frameRef.current?.contentWindow
      if (!win) throw new Error('The viewer frame is not ready.')
      win.postMessage(
        {
          type: 'LOAD_MESH_DATA',
          data: buf,
          filename: plyPath.split(/[\/]/).pop() || 'scene.ply',
          format: 'ply',
          timestamp: Date.now()
        },
        '*',
        [buf]
      )
      setSize(total)
      setState('handed')
      // Pin the lens so the framing on screen is the framing that renders.
      if (typeof fovDeg === 'number') win.postMessage({ type: 'SET_FOV', fovDeg }, '*')
    } catch (e) {
      setState('error')
      setDetail(e instanceof Error ? e.message : String(e))
    }
  }

  // Keep the viewer standing where the shot stands.
  useEffect(() => {
    if (state !== 'handed' || !pose) return
    const R = loadRotation.current
    frameRef.current?.contentWindow?.postMessage(
      {
        type: 'SET_CAMERA',
        position: rotate(R, pose.position),
        target: rotate(R, pose.target),
        // Screen-up in the loaded frame. With a rotation applied that is what
        // the scene's up became; with none, the file's own frame is already it.
        up: R ? [0, 0, -1] : OPENCV_UP,
        fovDeg
      },
      '*'
    )
  }, [pose?.position[0], pose?.position[1], pose?.position[2], pose?.target[0], pose?.target[1], pose?.target[2], fovDeg, state])

  // Keep the viewer on the shot's lens while it is being tuned.
  useEffect(() => {
    if (state !== 'handed' || typeof fovDeg !== 'number') return
    frameRef.current?.contentWindow?.postMessage({ type: 'SET_FOV', fovDeg }, '*')
  }, [fovDeg, state])

  return (
    <div className="viewer-shell">
      <div className="viewer-bar">
        <strong>{label}</strong>
        {status && <strong className="viewer-status">{status}</strong>}
        <span className="empty">
          {state === 'loading' && (detail || 'Reading the splat…')}
          {state === 'handed' &&
            `Handed ${(size / 1048576).toFixed(0)} MB to the viewer — a splat this size takes a while to appear. ` +
              'Then fly with W A S D and the mouse and use the viewer’s own screenshot button.' +
              (flipped ? '' : ' NOTE: no Y-up copy of this splat exists, so it will render upside down.')}
          {state === 'error' && detail}
        </span>
        {onGrab && (
          <button
            type="button"
            disabled={state !== 'handed'}
            onClick={() => frameRef.current?.contentWindow?.postMessage({ type: 'GET_CAMERA' }, '*')}
          >
            {grabLabel}
          </button>
        )}
        <button type="button" onClick={onClose}>
          Close
        </button>
      </div>
      <iframe
        ref={frameRef}
        className="viewer-frame"
        src={`${VIEWER_SRC}?v=${Date.now()}`}
        allow="fullscreen; clipboard-write"
        onLoad={pushMesh}
        title={label}
      />
    </div>
  )
}
