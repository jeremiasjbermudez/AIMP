import { useEffect, useRef, useState } from 'react'
import * as THREE from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { blenderToThree, verticalFov, type Mat4Rows } from './stageCamera'

// The view through one camera on a take, at one frame: the take's set and its performer
// (take.glb, exported by build_take.py with the performers' animation) seen through the
// camera path the setup produces. The same path is what Shoot stages, so this is the frame.

const ASPECT = 1344 / 576

type Loaded = { root: THREE.Object3D; mixer: THREE.AnimationMixer }

export function TakeViewfinder({ glbUrl, frame, matrix, lensMm }: {
  glbUrl: string
  frame: number            // 1-based
  matrix: Mat4Rows | null  // the camera on this frame (Blender coordinates)
  lensMm: number
}) {
  const host = useRef<HTMLDivElement>(null)
  const three = useRef<{ renderer: THREE.WebGLRenderer; scene: THREE.Scene; camera: THREE.PerspectiveCamera } | null>(null)
  const loaded = useRef<Loaded | null>(null)
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading')
  const [error, setError] = useState<string | null>(null)

  // One renderer per viewfinder.
  useEffect(() => {
    const el = host.current
    if (!el) return
    const renderer = new THREE.WebGLRenderer({ antialias: true })
    renderer.outputColorSpace = THREE.SRGBColorSpace
    renderer.toneMapping = THREE.ACESFilmicToneMapping
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    el.appendChild(renderer.domElement)
    const scene = new THREE.Scene()
    scene.background = new THREE.Color(0x15181c)
    // The block-out's own lights do not travel in glTF: an even light to frame by.
    scene.add(new THREE.HemisphereLight(0xfff4e6, 0x3a3530, 1.6))
    const key = new THREE.PointLight(0xffe0bb, 12, 12, 1.6)
    key.position.set(0, 2.3, 0)
    scene.add(key)
    const camera = new THREE.PerspectiveCamera(40, ASPECT, 0.05, 60)
    camera.matrixAutoUpdate = false
    three.current = { renderer, scene, camera }
    const resize = () => {
      const w = el.clientWidth
      renderer.setSize(w, Math.round(w / ASPECT))
    }
    resize()
    const ro = new ResizeObserver(resize)
    ro.observe(el)
    return () => {
      ro.disconnect()
      renderer.dispose()
      el.removeChild(renderer.domElement)
      three.current = null
    }
  }, [])

  // The take.
  useEffect(() => {
    const t = three.current
    if (!t) return
    setState('loading')
    let cancelled = false
    new GLTFLoader().load(
      glbUrl,
      (gltf) => {
        if (cancelled) return
        if (loaded.current) t.scene.remove(loaded.current.root)
        const mixer = new THREE.AnimationMixer(gltf.scene)
        for (const clip of gltf.animations) mixer.clipAction(clip).play()
        t.scene.add(gltf.scene)
        loaded.current = { root: gltf.scene, mixer }
        setState('ready')
      },
      undefined,
      (e) => {
        if (cancelled) return
        setError(e instanceof Error ? e.message : String(e))
        setState('error')
      }
    )
    return () => {
      cancelled = true
    }
  }, [glbUrl])

  // Every change of frame, camera or lens: pose the take and the camera, and draw.
  useEffect(() => {
    const t = three.current
    if (!t || !matrix) return
    // build_take keys frame f at f/24 s (the glTF's first key is frame 1 at 1/24 s).
    loaded.current?.mixer.setTime(frame / 24)
    t.camera.fov = verticalFov(lensMm, ASPECT)
    t.camera.updateProjectionMatrix()
    t.camera.matrixWorld.fromArray(blenderToThree(matrix))
    t.camera.matrixWorldInverse.copy(t.camera.matrixWorld).invert()
    t.renderer.render(t.scene, t.camera)
  }, [frame, matrix, lensMm, state])

  return (
    <div className="take-viewfinder">
      <div ref={host} className="take-viewfinder-canvas" />
      {state === 'loading' && <p className="empty">Loading the take…</p>}
      {state === 'error' && <p className="error">The take's 3D did not load: {error}. Rebuild the take to export it.</p>}
    </div>
  )
}
