import { useEffect, useMemo, useRef, useState } from 'react'
import { insforge, comfyViewUrl, type Movie } from './insforge'
import { triggerFlow, parseFlowJson } from './flowise'
import { Select } from './ui/Select'
import { TakeViewfinder } from './TakeViewfinder'
import {
  cameraPath, halfAngle, newCamera, MOTIONS,
  type MotionType, type StageCam, type Vec3
} from './stageCamera'

/**
 * Camera setup: put cameras on a take, see through them, shoot them all.
 *
 * A take is a scene's performance in its Blender set (Blender Sets > Takes). Here you
 * add cameras, drag them on the plan, choose a lens, a move and how handheld it is, and
 * watch the take through each one. Shoot stages every camera on the take and renders
 * its clip: each camera's path is computed here, frame by frame, and staging replays it
 * exactly - the frame in the viewfinder is the frame that renders.
 */

const SETS_VIEW = 'input/sets'
const slashed = (p: string) => p.split(String.fromCharCode(92)).join('/')
const setsView = (rel: string, cacheKey?: string) => comfyViewUrl(`${SETS_VIEW}/${slashed(rel)}`, cacheKey)
const LENSES = [18, 24, 28, 35, 40, 50, 65, 85, 100, 135].map((l) => ({ value: String(l), label: `${l} mm` }))
const plain = (s: string) => s.replace(/[^A-Za-z0-9_.-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 80)

type Facts = {
  name?: string
  dimensions_m?: { width: number; depth?: number }
  anchors?: Record<string, Vec3>
  blockout?: { room?: { shape?: string } }
}
type SetLocation = { id: string; location_key: string; revision: string; name: string; facts: Facts }
type FrameRow = { frame: number; x: number; y: number; heading_deg: number; pose: string; eyes?: Vec3 }
type SetTake = {
  id: string
  set_location_id: string
  take_key: string
  status: string
  blend_path: string | null
  take: {
    clock: { frames: number }
    performers: { id: string; display: string; eye_height_m?: number; seat_top_m?: number; keys: { t: number; mark?: string; facing?: string; pose?: string }[] }[]
    cues: { t: number; text: string }[]
  }
  manifest: { glb?: string; performers: Record<string, { frames: FrameRow[] }> } | null
  cameras: StageCam[] | null
}
type DirectorShot = { id: string; position: number; scene_number: number | null; shot_type: string | null; motion_prompt: string | null }
type Shot = { shot_key: string; clip_id: string | null; status: string }
type Clip = { id: string; status: string; video_path: string | null; error_message: string | null }
type ShootState = { state: 'waiting' | 'staging' | 'rendering' | 'done' | 'failed'; note?: string }

const shotLabel = (d: DirectorShot) =>
  `#${d.position}${d.scene_number ? ` · scene ${d.scene_number}` : ''} · ${d.shot_type ?? 'shot'} · ` +
  (d.motion_prompt ?? '').replace(/^Cinematic,\s*live-action\.\s*/i, '').slice(0, 36)

function Plan({ facts, performerPath, performerAt, cams, paths, frame, selected, onSelect, onMove }: {
  facts: Facts
  performerPath: [number, number][]
  performerAt: FrameRow | null
  cams: StageCam[]
  paths: Record<string, ReturnType<typeof cameraPath>>
  frame: number
  selected: string | null
  onSelect: (id: string) => void
  onMove: (id: string, x: number, y: number) => void
}) {
  const svg = useRef<SVGSVGElement>(null)
  const [drag, setDrag] = useState<string | null>(null)
  const w = facts.dimensions_m?.width ?? 4
  const d = facts.dimensions_m?.depth ?? w
  const round = facts.blockout?.room?.shape === 'round'
  const pad = 0.8
  const y = (v: number) => -v
  const toWorld = (e: React.PointerEvent) => {
    const el = svg.current
    const ctm = el?.getScreenCTM()
    if (!el || !ctm) return null
    const pt = el.createSVGPoint()
    pt.x = e.clientX
    pt.y = e.clientY
    const p = pt.matrixTransform(ctm.inverse())
    return { x: p.x, y: -p.y }
  }
  return (
    <svg
      ref={svg}
      className="stage-plan"
      viewBox={`${-w / 2 - pad} ${-d / 2 - pad} ${w + 2 * pad} ${d + 2 * pad}`}
      onPointerMove={(e) => {
        if (!drag) return
        const p = toWorld(e)
        if (p) onMove(drag, Math.round(p.x * 100) / 100, Math.round(p.y * 100) / 100)
      }}
      onPointerUp={() => setDrag(null)}
      onPointerLeave={() => setDrag(null)}
      role="img"
      aria-label="Plan of the set: drag a camera to move it"
    >
      {round ? <circle cx={0} cy={0} r={w / 2} className="stage-room" /> : <rect x={-w / 2} y={-d / 2} width={w} height={d} className="stage-room" />}
      {Object.entries(facts.anchors ?? {}).map(([name, v]) => (
        <g key={name} className="stage-mark">
          <circle cx={v[0]} cy={y(v[1])} r={0.04} />
          <text x={v[0] + 0.07} y={y(v[1]) + 0.04}>{name.replace(/^ANCHOR_/, '').replace(/^(stand|sit)_/, '')}</text>
        </g>
      ))}
      <polyline className="stage-actor-path" points={performerPath.map(([a, b]) => `${a},${y(b)}`).join(' ')} />
      {performerAt && (
        <g className="stage-actor">
          <circle cx={performerAt.x} cy={y(performerAt.y)} r={0.13} />
          <line
            x1={performerAt.x} y1={y(performerAt.y)}
            x2={performerAt.x + Math.cos((performerAt.heading_deg * Math.PI) / 180) * 0.3}
            y2={y(performerAt.y + Math.sin((performerAt.heading_deg * Math.PI) / 180) * 0.3)}
          />
        </g>
      )}
      {cams.map((c) => {
        const path = paths[c.id]
        if (!path) return null
        const m = path[Math.min(frame, path.length) - 1]
        const px = m[0][3], py = m[1][3]
        const h = Math.atan2(-m[1][2], -m[0][2])
        const a = halfAngle(c.lensMm)
        const reach = 1.4
        const trail = path.filter((_, i) => i % 4 === 0).map((q) => `${q[0][3]},${y(q[1][3])}`).join(' ')
        return (
          <g key={c.id} className={'stage-cam' + (c.id === selected ? ' selected' : '')}>
            <polyline className="stage-cam-trail" points={trail} />
            <path className="stage-cam-view" d={`M ${px} ${y(py)} L ${px + Math.cos(h - a) * reach} ${y(py + Math.sin(h - a) * reach)} L ${px + Math.cos(h + a) * reach} ${y(py + Math.sin(h + a) * reach)} Z`} />
            <circle
              cx={px} cy={y(py)} r={0.12}
              onPointerDown={(e) => {
                e.preventDefault()
                ;(e.target as Element).setPointerCapture?.(e.pointerId)
                onSelect(c.id)
                setDrag(c.id)
              }}
            />
            <text x={px + 0.15} y={y(py) - 0.12}>{c.name}</text>
          </g>
        )
      })}
    </svg>
  )
}

export function StagePanel({ movie }: { movie: Movie }) {
  const flowId = import.meta.env.VITE_BLENDER_SETS_ID
  const [locs, setLocs] = useState<SetLocation[]>([])
  const [takes, setTakes] = useState<SetTake[]>([])
  const [dshots, setDshots] = useState<DirectorShot[]>([])
  const [takeId, setTakeId] = useState('')
  const [cams, setCams] = useState<StageCam[]>([])
  const [selected, setSelected] = useState<string | null>(null)
  const [frame, setFrame] = useState(1)
  const [playing, setPlaying] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [shoot, setShoot] = useState<Record<string, ShootState>>({})
  const [shots, setShots] = useState<Shot[]>([])
  const [clips, setClips] = useState<Record<string, Clip>>({})
  const loadedFor = useRef<string | null>(null)
  // A new take from the shot list: the set it is in, and the shots it performs.
  const [newSet, setNewSet] = useState('')
  const [newShots, setNewShots] = useState<string[]>([])
  const [newNotes, setNewNotes] = useState('')

  async function load() {
    const [l, t] = await Promise.all([
      insforge.database.from('set_locations').select('id,location_key,revision,name,facts').eq('movie_id', movie.id),
      insforge.database.from('set_takes').select('*').eq('movie_id', movie.id).order('created_at', { ascending: true })
    ])
    setLocs((l.data ?? []) as SetLocation[])
    const ts = ((t.data ?? []) as SetTake[]).filter((x) => x.status === 'built')
    setTakes(ts)
    setTakeId((cur) => (cur && ts.some((x) => x.id === cur) ? cur : ts[ts.length - 1]?.id ?? ''))
    const d = await insforge.database.from('director_shots').select('id,position,scene_number,shot_type,motion_prompt').eq('movie_id', movie.id).order('position', { ascending: true })
    setDshots(d.error ? [] : ((d.data ?? []) as DirectorShot[]))
  }

  async function loadShots(id: string) {
    const s = await insforge.database.from('set_shots').select('shot_key,clip_id,status').eq('take_id', id)
    const list = (s.data ?? []) as Shot[]
    setShots(list)
    const ids = list.map((x) => x.clip_id).filter((x): x is string => !!x)
    if (ids.length) {
      const c = await insforge.database.from('minimax_clips').select('id,status,video_path,error_message').in('id', ids)
      setClips(Object.fromEntries(((c.data ?? []) as Clip[]).map((x) => [x.id, x])))
    }
  }

  useEffect(() => {
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [movie.id])

  const take = takes.find((t) => t.id === takeId) ?? null
  const loc = locs.find((l) => l.id === take?.set_location_id) ?? null
  const frames = take?.take.clock.frames ?? 124
  const performer = take?.take.performers[0]
  const track: FrameRow[] = (take?.manifest?.performers?.[performer?.id ?? ''] ?? Object.values(take?.manifest?.performers ?? {})[0])?.frames ?? []
  const eyes: Vec3[] = useMemo(
    () => track.map((r) => r.eyes ?? [r.x, r.y, performer?.eye_height_m ?? 1.65]),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [takeId, take?.manifest]
  )
  const ready = !!take?.manifest?.glb && eyes.length > 0

  // A take's cameras are its own; switching take brings its cameras up.
  useEffect(() => {
    if (!take) return
    loadedFor.current = null
    setCams(take.cameras ?? [])
    setSelected((take.cameras ?? [])[0]?.id ?? null)
    setFrame(1)
    setShoot({})
    loadShots(take.id)
    // Only mark as loaded after the cameras above are in state, so they are not saved back straight away.
    const id = take.id
    setTimeout(() => { loadedFor.current = id }, 0)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [takeId])

  // Save the setup with the take, a moment after the last change.
  useEffect(() => {
    if (!take || loadedFor.current !== take.id) return
    const t = setTimeout(async () => {
      const { error: e } = await insforge.database.from('set_takes').update({ cameras: cams }).eq('id', take.id)
      if (e) setError('The camera setup was not saved: ' + e.message)
      else setTakes((ts) => ts.map((x) => (x.id === take.id ? { ...x, cameras: cams } : x)))
    }, 600)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cams])

  // Play at 24 fps, looping.
  useEffect(() => {
    if (!playing) return
    const t = setInterval(() => setFrame((f) => (f >= frames ? 1 : f + 1)), 1000 / 24)
    return () => clearInterval(t)
  }, [playing, frames])

  const paths = useMemo(() => Object.fromEntries(cams.map((c) => [c.id, eyes.length ? cameraPath(c, eyes) : []])), [cams, eyes])
  const cam = cams.find((c) => c.id === selected) ?? null
  const camPath = cam ? paths[cam.id] : null
  const edit = (patch: Partial<StageCam>) => cam && setCams((cs) => cs.map((c) => (c.id === cam.id ? { ...c, ...patch } : c)))
  const editMotion = (patch: Partial<StageCam['motion']>) => cam && edit({ motion: { ...cam.motion, ...patch } })

  function addCamera() {
    if (!eyes.length) return
    const letter = String.fromCharCode(65 + (cams.length % 26))
    const facing = track[0]?.heading_deg ?? null
    // Inside the walls, with room to stand: 0.35 m from a wall.
    const w = loc?.facts.dimensions_m?.width ?? 4
    const dd = loc?.facts.dimensions_m?.depth ?? w
    const round = loc?.facts.blockout?.room?.shape === 'round'
    const inside = (x: number, y: number) => (round ? Math.hypot(x, y) < w / 2 - 0.35 : Math.abs(x) < w / 2 - 0.35 && Math.abs(y) < dd / 2 - 0.35)
    const c = newCamera(`CAM ${letter}`, eyes, facing, inside)
    setCams((cs) => [...cs, c])
    setSelected(c.id)
  }

  /** The model blocks the ticked shots on the set, and the take is built, ready for cameras. */
  async function newTakeFromShots() {
    const set = newSet || latestSets[latestSets.length - 1]?.id
    if (!set || !newShots.length) return
    setBusy('newtake')
    setError(null)
    setNote('The model is blocking the scene on the set, then the take is built. About a minute.')
    const ordered = dshots.filter((d) => newShots.includes(d.id)).map((d) => d.id)
    const r = parseFlowJson<{ action: string; reason?: string; takeId?: string; reading?: string }>(
      await triggerFlow(flowId, { action: 'draft_take', movieId: movie.id, setLocationId: set, directorShotIds: ordered, notes: newNotes.trim() || undefined, build: true })
    )
    setBusy(null)
    setNote(null)
    if (!r.ok) return setError(r.message)
    if (r.data.action === 'error') return setError(r.data.reason ?? 'The take was not made.')
    if (r.data.reading) setNote('The model\'s blocking: ' + r.data.reading)
    setNewShots([])
    await load()
    if (r.data.takeId) setTakeId(r.data.takeId)
  }

  /** Bring an older take up to date: rebuilding exports its 3D and its eye points. */
  async function rebuildTake() {
    if (!take) return
    setBusy('rebuild')
    setError(null)
    setNote(`Rebuilding ${take.take_key} for camera setup…`)
    const r = parseFlowJson<{ action: string; reason?: string }>(
      await triggerFlow(flowId, {
        action: 'save_take', movieId: movie.id, setLocationId: take.set_location_id,
        take: {
          takeKey: take.take_key, frames: take.take.clock.frames,
          performers: take.take.performers.map((p) => ({ name: p.display, eyeHeightM: p.eye_height_m, seatTopM: p.seat_top_m, keys: p.keys })),
          cues: take.take.cues
        }
      })
    )
    setBusy(null)
    setNote(null)
    if (!r.ok) return setError(r.message)
    if (r.data.action === 'error') return setError(r.data.reason ?? 'The take did not rebuild.')
    await load()
  }

  /** Stage every camera on the take and render its clip, one after another: the master
   *  first, then the rest given the master's frames so every angle is the same room. */
  async function shootAll(only?: string) {
    if (!take || !loc) return
    const master = cams.find((c) => c.master) ?? cams[0]
    const list = cams.filter((c) => !only || c.id === only).sort((a, b) => (a.id === master?.id ? -1 : b.id === master?.id ? 1 : 0))
    // Shooting one other camera alone matches the master's last finished clip, if there is one.
    let canonClipId: string | undefined = master && only && only !== master.id
      ? (lastClip(master)?.status === 'complete' ? lastClip(master)!.id : undefined)
      : undefined
    setBusy('shoot')
    setError(null)
    setShoot(Object.fromEntries(list.map((c) => [c.id, { state: 'waiting' } as ShootState])))
    for (const c of list) {
      const shotKey = plain(`${take.take_key}_${c.name}`)
      setShoot((s) => ({ ...s, [c.id]: { state: 'staging', note: 'depth, masks and plates…' } }))
      const path = paths[c.id]
      const st = parseFlowJson<{ action: string; reason?: string; shotId?: string }>(
        await triggerFlow(flowId, {
          action: 'stage', movieId: movie.id, setLocationId: take.set_location_id, takeId: take.id,
          shot: { shotKey, lensMm: c.lensMm, cameraPath: path.map((matrix, i) => ({ frame: i + 1, matrix })) }
        })
      )
      if (!st.ok || st.data.action !== 'staged' || !st.data.shotId) {
        setShoot((s) => ({ ...s, [c.id]: { state: 'failed', note: st.ok ? st.data.reason : st.message } }))
        continue
      }
      setShoot((s) => ({ ...s, [c.id]: { state: 'rendering', note: 'the clip…' } }))
      const isMaster = c.id === master?.id
      const cl = parseFlowJson<{ action: string; reason?: string; clipId?: string }>(
        await triggerFlow(flowId, {
          action: 'make_clip', movieId: movie.id, setShotId: st.data.shotId, directorShotId: c.directorShotId || undefined,
          canonClipId: isMaster ? undefined : canonClipId, render: true
        })
      )
      if (isMaster && cl.ok && cl.data.action === 'rendered' && cl.data.clipId) canonClipId = cl.data.clipId
      const ok = cl.ok && (cl.data.action === 'rendered' || cl.data.action === 'rendering')
      setShoot((s) => ({ ...s, [c.id]: ok ? { state: 'done', note: cl.ok && cl.data.action === 'rendering' ? 'still rendering' : undefined } : { state: 'failed', note: cl.ok ? cl.data.reason : cl.message } }))
      await loadShots(take.id)
    }
    setBusy(null)
  }

  const lastClip = (c: StageCam) => {
    const s = shots.find((x) => x.shot_key === plain(`${take?.take_key}_${c.name}`))
    return s?.clip_id ? clips[s.clip_id] : undefined
  }
  // The newest revision of each set, for making a take in.
  const latestSets = Object.values(locs.reduce<Record<string, SetLocation>>((acc, l) => {
    const cur = acc[l.location_key]
    if (!cur || l.revision > cur.revision) acc[l.location_key] = l
    return acc
  }, {}))
  const newTakeBox = (
    <details className="sets-take-editor" open={!takes.length}>
      <summary>New take from the shot list</summary>
      <p className="empty">
        Tick shots of one scene that run on from each other (one clip long at most). The model blocks where people
        stand and move on the set's marks, the lines land at their script times, and the take is built for cameras.
      </p>
      <div className="camera-row">
        <label>
          Set
          <Select
            value={newSet || latestSets[latestSets.length - 1]?.id || ''}
            onValueChange={setNewSet}
            placeholder="Pick a set…"
            items={latestSets.map((l) => ({ value: l.id, label: `${l.name} · ${l.revision}` }))}
          />
        </label>
        <label className="grow">
          Notes (optional)
          <input type="text" placeholder="He starts at the stove" value={newNotes} onChange={(e) => setNewNotes(e.target.value)} />
        </label>
        <button type="button" disabled={!!busy || !newShots.length || !latestSets.length} onClick={newTakeFromShots}>
          {busy === 'newtake' ? 'Blocking…' : `Block ${newShots.length || ''} shot${newShots.length === 1 ? '' : 's'}`}
        </button>
      </div>
      <div className="sets-draft-shots">
        {dshots.map((d) => (
          <label className="checkbox" key={d.id}>
            <input type="checkbox" checked={newShots.includes(d.id)} onChange={(e) => setNewShots((ids) => (e.target.checked ? [...ids, d.id] : ids.filter((x) => x !== d.id)))} />
            {shotLabel(d)}
          </label>
        ))}
      </div>
      {!latestSets.length && <p className="empty">No sets yet: build one from a scene's panorama in Locations first.</p>}
    </details>
  )
  const cues = take?.take.cues ?? []
  const at = track[frame - 1] ?? null

  if (!takes.length) {
    return (
      <div>
        <p>Camera setup works on a <strong>take</strong>: a scene's performance in its set. Make one from the shot list:</p>
        {newTakeBox}
        {note && <p className="empty">{note}</p>}
        {error && <p className="error">{error}</p>}
      </div>
    )
  }

  return (
    <div>
      <div className="camera-row">
        <label>
          Take
          <Select
            value={takeId}
            onValueChange={setTakeId}
            items={takes.map((t) => {
              const l = locs.find((x) => x.id === t.set_location_id)
              return { value: t.id, label: `${t.take_key}${l ? ` · ${l.name} ${l.revision}` : ''} · ${(t.take.clock.frames / 24).toFixed(1)} s` }
            })}
          />
        </label>
        <button type="button" onClick={addCamera} disabled={!ready || !!busy}>Add camera</button>
        <button type="button" onClick={() => shootAll()} disabled={!ready || !cams.length || !!busy}>
          {busy === 'shoot' ? 'Shooting…' : `Shoot ${cams.length || ''} camera${cams.length === 1 ? '' : 's'}`}
        </button>
      </div>
      {newTakeBox}
      {take && !ready && (
        <p className="error">
          {take.take_key} was built before camera setup existed.{' '}
          <button type="button" onClick={rebuildTake} disabled={!!busy}>{busy === 'rebuild' ? 'Rebuilding…' : 'Rebuild it'}</button>
        </p>
      )}
      {note && <p className="empty">{note}</p>}
      {error && <p className="error">{error}</p>}

      {take && loc && ready && (
        <div className="stage-layout">
          <div className="stage-left">
            <Plan
              facts={loc.facts}
              performerPath={track.filter((_, i) => i % 3 === 0).map((r) => [r.x, r.y])}
              performerAt={at}
              cams={cams}
              paths={paths}
              frame={frame}
              selected={selected}
              onSelect={setSelected}
              onMove={(id, x, y) => setCams((cs) => cs.map((c) => (c.id === id ? { ...c, position: [x, y, c.position[2]] } : c)))}
            />
            <p className="empty">Drag a camera to move it. The green line is where {performer?.display ?? 'the actor'} goes; the faint lines are each camera's path.</p>
          </div>

          <div className="stage-right">
            {cam && camPath ? (
              <TakeViewfinder glbUrl={setsView(take.blend_path!.replace(/take\.blend$/, 'take.glb'), take.id)} frame={frame} matrix={camPath[frame - 1] ?? null} lensMm={cam.lensMm} />
            ) : (
              <p className="empty">Add a camera to look through it.</p>
            )}
            <div className="stage-timeline">
              <button type="button" onClick={() => setPlaying((p) => !p)}>{playing ? 'Pause' : 'Play'}</button>
              <div className="stage-scrub">
                <input type="range" min={1} max={frames} value={frame} onChange={(e) => { setPlaying(false); setFrame(Number(e.target.value)) }} aria-label="Frame" />
                <div className="stage-cues">
                  {cues.map((c) => (
                    <span key={c.t + c.text} style={{ left: `${(c.t * 24) / frames * 100}%` }} title={c.text} />
                  ))}
                </div>
              </div>
              <span className="empty">{(frame / 24).toFixed(2)} s · {frame}/{frames}</span>
            </div>
            {cues.filter((c) => Math.abs(c.t * 24 - frame) < 18).map((c) => <p key={c.t + c.text} className="empty stage-cue-now">{c.t.toFixed(1)} s: {c.text}</p>)}

            <div className="stage-cams">
              {cams.map((c) => (
                <button key={c.id} type="button" className={'stage-cam-chip' + (c.id === selected ? ' selected' : '')} onClick={() => setSelected(c.id)}>
                  {c.name} <span className="empty">{c.lensMm} mm · {MOTIONS.find((m) => m.value === c.motion.type)?.label}{c.handheld > 0 ? ' · handheld' : ''}</span>
                  {shoot[c.id] && <span className={shoot[c.id].state === 'failed' ? 'error' : 'badge'}> {shoot[c.id].state}</span>}
                </button>
              ))}
            </div>

            {cam && (
              <div className="stage-inspector">
                <div className="camera-row">
                  <label>
                    Name
                    <input type="text" value={cam.name} onChange={(e) => edit({ name: e.target.value })} />
                  </label>
                  <label>
                    Lens
                    <Select value={String(cam.lensMm)} onValueChange={(v) => edit({ lensMm: Number(v) })} items={LENSES} />
                  </label>
                  <label>
                    Height {cam.position[2].toFixed(2)} m
                    <input type="range" min={0.4} max={2.6} step={0.05} value={cam.position[2]} onChange={(e) => edit({ position: [cam.position[0], cam.position[1], Number(e.target.value)] })} />
                  </label>
                </div>
                <div className="camera-row">
                  <label>
                    Move
                    <Select value={cam.motion.type} onValueChange={(v) => editMotion({ type: v as MotionType })} items={MOTIONS.map((m) => ({ value: m.value, label: m.label }))} />
                  </label>
                  {['push', 'pull', 'dolly', 'orbit'].includes(cam.motion.type) && (
                    <label>
                      {cam.motion.type === 'orbit' ? 'Degrees' : 'Metres'}
                      <input type="number" step={cam.motion.type === 'orbit' ? 5 : 0.1} value={cam.motion.amount} onChange={(e) => editMotion({ amount: Number(e.target.value) })} />
                    </label>
                  )}
                  {cam.motion.type !== 'static' && cam.motion.type !== 'follow' && (
                    <>
                      <label>
                        From (s)
                        <input type="number" step={0.1} value={cam.motion.startS} onChange={(e) => editMotion({ startS: Number(e.target.value) })} />
                      </label>
                      <label>
                        To (s)
                        <input type="number" step={0.1} value={cam.motion.endS} onChange={(e) => editMotion({ endS: Number(e.target.value) })} />
                      </label>
                    </>
                  )}
                  <label>
                    Handheld {cam.handheld === 0 ? 'off' : cam.handheld < 0.4 ? 'light' : cam.handheld < 0.75 ? 'medium' : 'loose'}
                    <input type="range" min={0} max={1} step={0.05} value={cam.handheld} onChange={(e) => edit({ handheld: Number(e.target.value) })} />
                  </label>
                </div>
                <p className="empty">{MOTIONS.find((m) => m.value === cam.motion.type)?.hint}.</p>
                <div className="camera-row">
                  {dshots.length > 0 && (
                    <label className="grow">
                      For the Director's shot
                      <Select value={cam.directorShotId ?? ''} onValueChange={(v) => edit({ directorShotId: v })} placeholder="Pick a shot…" items={dshots.map((d) => ({ value: d.id, label: shotLabel(d) }))} />
                    </label>
                  )}
                  <label className="checkbox">
                    <input
                      type="checkbox"
                      checked={(cams.find((c) => c.master) ?? cams[0])?.id === cam.id}
                      onChange={(e) => setCams((cs) => cs.map((c) => ({ ...c, master: e.target.checked ? c.id === cam.id : false })))}
                    />
                    Master: shot first, the others match it
                  </label>
                  <button type="button" onClick={() => {
                    const copy = { ...cam, master: false, id: `${cam.id}_c${Date.now().toString(36)}`, name: cam.name + ' 2', position: [cam.position[0] + 0.3, cam.position[1], cam.position[2]] as Vec3 }
                    setCams((cs) => [...cs, copy])
                    setSelected(copy.id)
                  }}>Duplicate</button>
                  <button type="button" disabled={!!busy} onClick={() => shootAll(cam.id)}>Shoot this one</button>
                  <button type="button" className="danger" onClick={() => { setCams((cs) => cs.filter((c) => c.id !== cam.id)); setSelected(null) }}>Remove</button>
                </div>
                {shoot[cam.id]?.note && <p className={shoot[cam.id].state === 'failed' ? 'error' : 'empty'}>{shoot[cam.id].state}: {shoot[cam.id].note}</p>}
                {lastClip(cam)?.video_path && (
                  <video className="shot-preview" src={comfyViewUrl(slashed(lastClip(cam)!.video_path!))} controls muted loop playsInline />
                )}
                {lastClip(cam) && !lastClip(cam)!.video_path && <p className="empty">Clip {lastClip(cam)!.status}{lastClip(cam)!.error_message ? ': ' + lastClip(cam)!.error_message : ''}</p>}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
