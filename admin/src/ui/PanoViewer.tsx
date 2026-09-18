import { useEffect, useRef, useState } from 'react'
import * as THREE from 'three'

// A 360 viewer for equirectangular panoramas, with a snapshot.
//
// Nothing installed does this - ComfyUI has a splat viewer but no pano viewer -
// so it is a sphere with the panorama mapped on the INSIDE (side: BackSide) and
// the camera at its centre. Dragging turns the camera; the wheel changes focal
// length. A snapshot is just the rendered canvas, which is exactly a normal
// perspective frame taken out of a 360 plate.
function dataUrlToFile(dataUrl: string, name: string): File {
  const [head, b64] = dataUrl.split(',')
  const mime = /:(.*?);/.exec(head)?.[1] ?? 'image/png'
  const bin = atob(b64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return new File([bytes], name, { type: mime })
}

export function PanoViewer({
  src,
  label,
  onSnapshot,
  onClose
}: {
  src: string
  label: string
  onSnapshot: (file: File, previewUrl: string) => void
  onClose: () => void
}) {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null)
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null)
  const sceneRef = useRef<THREE.Scene | null>(null)
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading')
  const [detail, setDetail] = useState('')
  const [fov, setFov] = useState(70)

  useEffect(() => {
    const host = hostRef.current
    if (!host) return

    const scene = new THREE.Scene()
    const camera = new THREE.PerspectiveCamera(70, host.clientWidth / host.clientHeight, 0.1, 1000)
    // Sitting at the centre of the sphere is what makes this a viewer rather
    // than a look at a ball.
    camera.position.set(0, 0, 0.01)
    const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true })
    renderer.setPixelRatio(window.devicePixelRatio)
    renderer.setSize(host.clientWidth, host.clientHeight)
    host.appendChild(renderer.domElement)
    sceneRef.current = scene
    cameraRef.current = camera
    rendererRef.current = renderer

    const geometry = new THREE.SphereGeometry(500, 60, 40)
    // Flipping on X turns the sphere inside out so the image is not mirrored.
    geometry.scale(-1, 1, 1)

    let mesh: THREE.Mesh | null = null
    new THREE.TextureLoader().load(
      src,
      (texture) => {
        texture.colorSpace = THREE.SRGBColorSpace
        mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ map: texture }))
        scene.add(mesh)
        setState('ready')
      },
      undefined,
      () => {
        setState('error')
        setDetail('The panorama could not be loaded.')
      }
    )

    // Look direction as spherical angles; simpler and more stable than
    // accumulating quaternions from drag deltas.
    let lon = 0
    let lat = 0
    let dragging = false
    let px = 0
    let py = 0

    const onDown = (e: PointerEvent) => {
      dragging = true
      px = e.clientX
      py = e.clientY
      renderer.domElement.setPointerCapture(e.pointerId)
    }
    const onMove = (e: PointerEvent) => {
      if (!dragging) return
      lon -= (e.clientX - px) * 0.12
      lat += (e.clientY - py) * 0.12
      // Clamped so the view cannot roll past the poles and flip upside down.
      lat = Math.max(-85, Math.min(85, lat))
      px = e.clientX
      py = e.clientY
    }
    const onUp = (e: PointerEvent) => {
      dragging = false
      try {
        renderer.domElement.releasePointerCapture(e.pointerId)
      } catch {
        /* the pointer may already be gone */
      }
    }
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      setFov((f) => Math.max(20, Math.min(100, f + Math.sign(e.deltaY) * 3)))
    }

    const el = renderer.domElement
    el.addEventListener('pointerdown', onDown)
    el.addEventListener('pointermove', onMove)
    el.addEventListener('pointerup', onUp)
    el.addEventListener('wheel', onWheel, { passive: false })

    let raf = 0
    const tick = () => {
      raf = requestAnimationFrame(tick)
      const phi = THREE.MathUtils.degToRad(90 - lat)
      const theta = THREE.MathUtils.degToRad(lon)
      camera.lookAt(
        500 * Math.sin(phi) * Math.cos(theta),
        500 * Math.cos(phi),
        500 * Math.sin(phi) * Math.sin(theta)
      )
      renderer.render(scene, camera)
    }
    tick()

    const onResize = () => {
      if (!host.clientWidth) return
      camera.aspect = host.clientWidth / host.clientHeight
      camera.updateProjectionMatrix()
      renderer.setSize(host.clientWidth, host.clientHeight)
    }
    const ro = new ResizeObserver(onResize)
    ro.observe(host)

    return () => {
      cancelAnimationFrame(raf)
      ro.disconnect()
      el.removeEventListener('pointerdown', onDown)
      el.removeEventListener('pointermove', onMove)
      el.removeEventListener('pointerup', onUp)
      el.removeEventListener('wheel', onWheel)
      // WebGL contexts are a limited resource; leaking one per open closes the
      // whole tab's ability to render after a handful of uses.
      geometry.dispose()
      if (mesh) {
        const m = mesh.material as THREE.MeshBasicMaterial
        m.map?.dispose()
        m.dispose()
      }
      renderer.dispose()
      if (renderer.domElement.parentNode === host) host.removeChild(renderer.domElement)
    }
  }, [src])

  useEffect(() => {
    const cam = cameraRef.current
    if (!cam) return
    cam.fov = fov
    cam.updateProjectionMatrix()
  }, [fov])

  function snapshot() {
    const renderer = rendererRef.current
    const scene = sceneRef.current
    const camera = cameraRef.current
    if (!renderer || !scene || !camera) return
    // Render once more immediately before reading: with preserveDrawingBuffer
    // the buffer is kept, but a frame may have been cleared since the last tick.
    renderer.render(scene, camera)
    const url = renderer.domElement.toDataURL('image/png')
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    onSnapshot(dataUrlToFile(url, `pano-${stamp}.png`), url)
  }

  return (
    <div className="viewer-shell">
      <div className="viewer-bar">
        <strong>{label}</strong>
        <span className="empty">
          {state === 'loading' && 'Loading the panorama…'}
          {state === 'ready' && 'Drag to look around, scroll to zoom.'}
          {state === 'error' && detail}
        </span>
        <label>
          FOV
          <input
            type="range"
            min={20}
            max={100}
            value={fov}
            onChange={(e) => setFov(Number(e.target.value))}
          />
        </label>
        <button type="button" disabled={state !== 'ready'} onClick={snapshot}>
          Take snapshot
        </button>
        <button type="button" onClick={onClose}>
          Close
        </button>
      </div>
      <div ref={hostRef} className="viewer-canvas" />
    </div>
  )
}
