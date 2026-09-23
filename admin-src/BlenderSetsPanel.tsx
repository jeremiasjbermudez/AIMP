import { useEffect, useMemo, useState } from 'react'
import { insforge, comfyViewUrl, type Movie } from './insforge'
import { triggerFlow, parseFlowJson } from './flowise'
import { Select } from './ui/Select'

/**
 * Blender sets: a location built once as a Blender block-out, and shots staged in it.
 *
 * From camera_lab (movie-mvp). The third kind of set beside a panorama and a
 * splat world: exact geometry instead of a generated picture. Staging a shot
 * puts a proxy actor on a mark and a camera around them, then renders what the
 * video route conditions on (metric depth, an actor mask, eight empty-room
 * plates) and works out which set pieces the camera will actually see.
 *
 * The renders run on the render host (flow 48-Blender-Sets, via its worker);
 * this panel only keeps the project's rows and shows the results.
 */

// Where the worker's sets root sits among ComfyUI's folders: install-worker.ps1
// puts it at <ComfyUI>\input\sets, so /view serves it as type=input, subfolder sets/...
const SETS_VIEW = 'input/sets'
const setsView = (rel: string, cacheKey?: string) => comfyViewUrl(`${SETS_VIEW}/${rel.split('\\').join('/')}`, cacheKey)

// MiniMax H3 clip lengths are 17k+5 frames; staging renders exactly the clip.
const FRAMES = [90, 107, 124, 141, 158, 175].map((n) => ({ value: String(n), label: `${n} frames · ${(n / 24).toFixed(1)} s` }))
const POSES = [
  { value: 'standing', label: 'Standing' },
  { value: 'seated', label: 'Seated' }
]

type Vec = [number, number, number]
type LocationFacts = {
  name?: string
  dimensions_m?: { width: number; depth: number; eave_height?: number; ridge_height?: number }
  anchors?: Record<string, Vec>
  set_pieces?: Record<string, string[]>
}
type Available = { id: string; revision: string; name: string; anchors: string[]; setPieces: string[] }
type SetLocation = {
  id: string
  location_key: string
  revision: string
  name: string
  facts: LocationFacts
  created_at: string
}
type Visibility = {
  summary?: { always: string[]; sometimes: string[]; never: string[] }
  placement?: Record<string, string>
  background_risk?: string | null
}
type ShotSpec = {
  character?: { display: string; mark: string; facing: string; pose: string; eye_height_m: number } | null
  camera?: { lens_mm: number; azimuth_deg_from_character?: number; start_distance_m?: number; height_m?: number }
  clock?: { frames: number }
}
type SetShot = {
  id: string
  set_location_id: string
  shot_key: string
  shot: ShotSpec
  status: string
  stage: { blenderDir: string; depthFrames: number; plates?: { plates: { camera: string; lens_mm: number }[] } } | null
  visibility: Visibility | null
  scout_sheet: string | null
  error_message: string | null
  updated_at: string
}

type Draft = {
  shotKey: string
  character: string
  mark: string
  facing: string
  pose: string
  eyeHeightM: string
  lensMm: string
  azimuthDeg: string
  distanceM: string
  heightM: string
  frames: string
  move: boolean
  endDistanceM: string
}
const EMPTY: Draft = {
  shotKey: '', character: '', mark: '', facing: '', pose: 'standing', eyeHeightM: '1.68',
  lensMm: '50', azimuthDeg: '30', distanceM: '2.2', heightM: '1.6', frames: '124', move: false, endDistanceM: '1.4'
}

/** Where the stage will put the camera, in plan: the same sum blender_stage.py does. */
function cameraInPlan(anchors: Record<string, Vec>, mark: string, facing: string, azimuthDeg: number, distance: number) {
  const m = anchors[mark]
  if (!m) return null
  const f = anchors[facing]
  let fx = f ? f[0] - m[0] : 0
  let fy = f ? f[1] - m[1] : 1
  if (Math.hypot(fx, fy) < 1e-6) { fx = 0; fy = 1 }
  // Azimuth is measured from the character's facing direction, counter-clockwise
  // seen from above: 0 is straight in front of them.
  const a = Math.atan2(fy, fx) + (azimuthDeg * Math.PI) / 180
  return { mark: m, cam: [m[0] + Math.cos(a) * distance, m[1] + Math.sin(a) * distance] as [number, number] }
}

function Plan({ facts, cams }: {
  facts: LocationFacts
  cams: { key: string; mark: string; facing: string; az: number; dist: number; draft?: boolean }[]
}) {
  const anchors = facts.anchors ?? {}
  const dims = facts.dimensions_m
  const pts = Object.values(anchors).map((v) => [v[0], v[1]])
  const w = dims?.width ?? Math.max(2, ...pts.map((p) => Math.abs(p[0]) * 2 + 0.5))
  const d = dims?.depth ?? Math.max(2, ...pts.map((p) => Math.abs(p[1]) * 2 + 0.5))
  const pad = 0.6
  // Blender is Z-up with +Y away; the plan draws +Y toward the top of the page.
  const vb = `${-w / 2 - pad} ${-d / 2 - pad} ${w + pad * 2} ${d + pad * 2}`
  const y = (v: number) => -v
  return (
    <svg className="sets-plan" viewBox={vb} role="img" aria-label={`Plan of ${facts.name ?? 'the set'}`}>
      <rect x={-w / 2} y={-d / 2} width={w} height={d} className="sets-plan-room" />
      {Object.entries(anchors).map(([name, v]) => (
        <g key={name}>
          <circle cx={v[0]} cy={y(v[1])} r={0.06} className="sets-plan-mark" />
          <text x={v[0] + 0.1} y={y(v[1]) + 0.05} className="sets-plan-label">{name.replace(/^ANCHOR_/, '')}</text>
        </g>
      ))}
      {cams.map((c) => {
        const p = cameraInPlan(anchors, c.mark, c.facing, c.az, c.dist)
        if (!p) return null
        return (
          <g key={c.key} className={c.draft ? 'sets-plan-cam draft' : 'sets-plan-cam'}>
            <line x1={p.cam[0]} y1={y(p.cam[1])} x2={p.mark[0]} y2={y(p.mark[1])} />
            <circle cx={p.cam[0]} cy={y(p.cam[1])} r={0.09} />
            <text x={p.cam[0] + 0.12} y={y(p.cam[1]) - 0.08} className="sets-plan-label">{c.key}</text>
          </g>
        )
      })}
    </svg>
  )
}

function VisibilityBadges({ v }: { v: Visibility }) {
  const s = v.summary
  if (!s) return null
  return (
    <>
      {v.background_risk && <p className="error">{v.background_risk}</p>}
      <p className="empty">
        <strong>In frame:</strong>{' '}
        {s.always.length ? s.always.map((p) => (
          <span key={p} className="badge" title={v.placement?.[p] ? `${v.placement[p]} of frame` : undefined}>{p}</span>
        )) : 'nothing but walls'}
      </p>
      {s.sometimes.length > 0 && (
        <p className="empty">
          <strong>Comes and goes:</strong> {s.sometimes.map((p) => <span key={p} className="badge">{p}</span>)}
        </p>
      )}
      {s.never.length > 0 && (
        <details>
          <summary className="empty">Never seen from here ({s.never.length})</summary>
          <p className="empty">{s.never.join(', ')}</p>
        </details>
      )}
    </>
  )
}

export function BlenderSetsPanel({ movie }: { movie: Movie }) {
  const flowId = import.meta.env.VITE_BLENDER_SETS_ID
  const [available, setAvailable] = useState<Available[]>([])
  const [availableError, setAvailableError] = useState<string | null>(null)
  const [locations, setLocations] = useState<SetLocation[]>([])
  const [shots, setShots] = useState<SetShot[]>([])
  const [pick, setPick] = useState('')
  const [locationId, setLocationId] = useState('')
  const [draft, setDraft] = useState<Draft>(EMPTY)
  const [busy, setBusy] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [scoutIds, setScoutIds] = useState<string[]>([])
  const [sheet, setSheet] = useState<string | null>(null)
  const [openPlates, setOpenPlates] = useState<string | null>(null)

  async function loadRows() {
    const [l, s] = await Promise.all([
      insforge.database.from('set_locations').select('*').eq('movie_id', movie.id).order('created_at', { ascending: true }),
      insforge.database.from('set_shots').select('*').eq('movie_id', movie.id).order('shot_key', { ascending: true })
    ])
    const locs = (l.data ?? []) as SetLocation[]
    setLocations(locs)
    setShots((s.data ?? []) as SetShot[])
    setLocationId((cur) => (cur && locs.some((x) => x.id === cur) ? cur : locs[0]?.id ?? ''))
  }

  async function loadAvailable() {
    const r = parseFlowJson<{ available: Available[]; availableError: string | null }>(
      await triggerFlow(flowId, { action: 'locations', movieId: movie.id })
    )
    if (!r.ok) {
      setAvailableError(r.message)
      return
    }
    setAvailable(r.data.available)
    setAvailableError(r.data.availableError)
  }

  useEffect(() => {
    setSheet(null)
    setScoutIds([])
    setDraft(EMPTY)
    loadRows()
    loadAvailable()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [movie.id])

  const location = locations.find((l) => l.id === locationId) ?? null
  const anchorItems = useMemo(
    () => Object.keys(location?.facts.anchors ?? {}).map((a) => ({ value: a, label: a.replace(/^ANCHOR_/, '') })),
    [location]
  )
  const locShots = shots.filter((s) => s.set_location_id === locationId)
  const notAdded = available.filter((a) => !locations.some((l) => l.location_key === a.id && l.revision === a.revision))

  // A new location starts the form on its first two marks, so the plan has a camera to show.
  useEffect(() => {
    const names = Object.keys(location?.facts.anchors ?? {})
    setDraft((d) => (names.includes(d.mark) ? d : { ...d, mark: names[0] ?? '', facing: names[1] ?? names[0] ?? '' }))
  }, [location])

  const set = (k: keyof Draft) => (v: string | boolean) => setDraft((d) => ({ ...d, [k]: v }))
  const blocked = !location
    ? 'a set'
    : !/^[A-Za-z0-9_.-]{1,80}$/.test(draft.shotKey.trim())
      ? 'a shot name (letters, digits, _ . -)'
      : !draft.mark
        ? 'a mark'
        : ''

  async function handleAdd() {
    const a = notAdded.find((x) => `${x.id}@${x.revision}` === pick)
    if (!a) return
    setBusy('add')
    setError(null)
    const r = parseFlowJson<{ setLocation: SetLocation }>(
      await triggerFlow(flowId, { action: 'add_location', movieId: movie.id, locationKey: a.id, revision: a.revision })
    )
    setBusy(null)
    if (!r.ok) return setError(r.message)
    setPick('')
    await loadRows()
    setLocationId(r.data.setLocation.id)
  }

  async function handleStage() {
    if (blocked || !location) return
    setBusy('stage')
    setError(null)
    setNote(`Staging ${draft.shotKey}: depth, actor mask and plates in Blender on the render host, then what the camera sees. About two minutes.`)
    const shot = {
      shotKey: draft.shotKey.trim(),
      character: draft.character.trim() || 'Actor',
      mark: draft.mark,
      facing: draft.facing || draft.mark,
      pose: draft.pose,
      eyeHeightM: Number(draft.eyeHeightM),
      lensMm: Number(draft.lensMm),
      azimuthDeg: Number(draft.azimuthDeg),
      distanceM: Number(draft.distanceM),
      heightM: Number(draft.heightM),
      frames: Number(draft.frames),
      move: draft.move,
      endDistanceM: Number(draft.endDistanceM)
    }
    const run = triggerFlow(flowId, { action: 'stage', movieId: movie.id, setLocationId: location.id, shot })
    // The flow marks the row as staging before it starts rendering; show it.
    setTimeout(loadRows, 1500)
    const r = parseFlowJson<{ action: string; reason?: string }>(await run)
    setBusy(null)
    setNote(null)
    if (!r.ok) setError(r.message)
    else if (r.data.action === 'error') setError(r.data.reason ?? 'Staging failed.')
    else setDraft((d) => ({ ...d, shotKey: '' }))
    await loadRows()
  }

  async function handleScout() {
    setBusy('scout')
    setError(null)
    setNote('Rendering the tech-scout sheet…')
    const r = parseFlowJson<{ action: string; sheet?: string; reason?: string }>(
      await triggerFlow(flowId, { action: 'scout', movieId: movie.id, shotIds: scoutIds })
    )
    setBusy(null)
    setNote(null)
    if (!r.ok) return setError(r.message)
    if (r.data.action === 'error' || !r.data.sheet) return setError(r.data.reason ?? 'The scout failed.')
    setSheet(r.data.sheet)
    await loadRows()
  }

  async function handleRemove(s: SetShot) {
    // The renders stay on the render host; this only takes the shot off the list.
    await insforge.database.from('set_shots').delete().eq('id', s.id)
    setScoutIds((ids) => ids.filter((x) => x !== s.id))
    await loadRows()
  }

  const planCams = [
    ...locShots.filter((s) => s.shot.character).map((s) => ({
      key: s.shot_key,
      mark: s.shot.character!.mark,
      facing: s.shot.character!.facing,
      az: s.shot.camera?.azimuth_deg_from_character ?? 0,
      dist: s.shot.camera?.start_distance_m ?? 2
    })),
    ...(draft.mark ? [{
      key: draft.shotKey.trim() || 'new',
      mark: draft.mark, facing: draft.facing, az: Number(draft.azimuthDeg) || 0, dist: Number(draft.distanceM) || 2, draft: true
    }] : [])
  ]

  return (
    <div>
      <p>
        A location built in Blender, kept by revision, and shots staged inside it. Staging renders the
        control passes a clip is made from (metric depth and an actor mask for every frame, plus eight
        plates of the empty room) and lists which set pieces the camera will actually see.
      </p>

      <h4>Sets</h4>
      <div className="camera-row">
        {locations.length > 0 && (
          <label>
            Set
            <Select
              value={locationId}
              onValueChange={setLocationId}
              items={locations.map((l) => ({ value: l.id, label: `${l.name} · ${l.revision}` }))}
            />
          </label>
        )}
        <label>
          Add from the render host
          <Select
            value={pick}
            onValueChange={setPick}
            placeholder={notAdded.length ? 'Pick a set…' : 'Nothing more to add'}
            items={notAdded.map((a) => ({ value: `${a.id}@${a.revision}`, label: `${a.name} · ${a.revision}` }))}
          />
        </label>
        <button type="button" disabled={!pick || !!busy} onClick={handleAdd}>
          {busy === 'add' ? 'Adding…' : 'Add set'}
        </button>
      </div>
      {availableError && <p className="error">{availableError}</p>}
      {locations.length === 0 && !availableError && (
        <p className="empty">No sets in {movie.title} yet. Add one the render host has, above.</p>
      )}

      {location && (
        <div className="sets-layout">
          <div>
            <Plan facts={location.facts} cams={planCams} />
            {location.facts.dimensions_m && (
              <p className="empty">
                {location.facts.dimensions_m.width} × {location.facts.dimensions_m.depth} m ·{' '}
                {Object.keys(location.facts.set_pieces ?? {}).length} set pieces
              </p>
            )}
          </div>

          <div>
            <h4>Stage a shot</h4>
            <div className="camera-row">
              <label>
                Shot
                <input type="text" placeholder="WH_A_01" value={draft.shotKey} onChange={(e) => set('shotKey')(e.target.value)} />
              </label>
              <label>
                Character
                <input type="text" placeholder="Actor" value={draft.character} onChange={(e) => set('character')(e.target.value)} />
              </label>
              <label>
                Pose
                <Select value={draft.pose} onValueChange={set('pose')} items={POSES} />
              </label>
              <label>
                Eye height (m)
                <input type="number" step="0.01" value={draft.eyeHeightM} onChange={(e) => set('eyeHeightM')(e.target.value)} />
              </label>
            </div>
            <div className="camera-row">
              <label>
                On mark
                <Select value={draft.mark} onValueChange={set('mark')} items={anchorItems} />
              </label>
              <label>
                Facing
                <Select value={draft.facing} onValueChange={set('facing')} items={anchorItems} />
              </label>
            </div>
            <div className="camera-row">
              <label>
                Lens (mm)
                <input type="number" value={draft.lensMm} onChange={(e) => set('lensMm')(e.target.value)} />
              </label>
              <label>
                Angle from their front (°)
                <input type="number" value={draft.azimuthDeg} onChange={(e) => set('azimuthDeg')(e.target.value)} />
              </label>
              <label>
                Distance (m)
                <input type="number" step="0.1" value={draft.distanceM} onChange={(e) => set('distanceM')(e.target.value)} />
              </label>
              <label>
                Camera height (m)
                <input type="number" step="0.05" value={draft.heightM} onChange={(e) => set('heightM')(e.target.value)} />
              </label>
            </div>
            <div className="camera-row">
              <label>
                Length
                <Select value={draft.frames} onValueChange={set('frames')} items={FRAMES} />
              </label>
              <label className="checkbox">
                <input type="checkbox" checked={draft.move} onChange={(e) => set('move')(e.target.checked)} />
                Push in
              </label>
              {draft.move && (
                <label>
                  Ends at (m)
                  <input type="number" step="0.1" value={draft.endDistanceM} onChange={(e) => set('endDistanceM')(e.target.value)} />
                </label>
              )}
              <button type="button" disabled={!!busy || !!blocked} onClick={handleStage}>
                {busy === 'stage' ? 'Staging…' : 'Stage the shot'}
              </button>
            </div>
            {!busy && blocked && <p className="empty">Staging needs: {blocked}.</p>}
          </div>
        </div>
      )}
      {note && <p className="empty">{note}</p>}
      {error && <p className="error">{error}</p>}

      {location && (
        <>
          <h4>Shots in {location.name}</h4>
          {locShots.length === 0 && <p className="empty">None staged yet.</p>}
          {locShots.some((s) => s.status === 'staged') && (
            <div className="camera-row">
              <button type="button" disabled={!!busy || scoutIds.length === 0} onClick={handleScout}>
                {busy === 'scout' ? 'Scouting…' : `Tech scout ${scoutIds.length || ''} shot${scoutIds.length === 1 ? '' : 's'}`}
              </button>
              <span className="empty">Tick the shots to lay out on one contact sheet with their coverage.</span>
            </div>
          )}
          <div className="clip-grid">
            {locShots.map((s) => {
              const c = s.shot.camera
              const ch = s.shot.character
              return (
                <div className="beat-card" key={s.id}>
                  <p>
                    {s.status === 'staged' && (
                      <input
                        type="checkbox"
                        aria-label={`Include ${s.shot_key} in the tech scout`}
                        checked={scoutIds.includes(s.id)}
                        onChange={(e) => setScoutIds((ids) => (e.target.checked ? [...ids, s.id] : ids.filter((x) => x !== s.id)))}
                      />
                    )}{' '}
                    <strong>{s.shot_key}</strong>{' '}
                    <span className={s.status === 'failed' ? 'error' : s.status === 'staged' ? 'run-status-ok' : 'badge'}>{s.status}</span>
                  </p>
                  {s.stage && (
                    <img
                      className="shot-preview"
                      src={setsView(`${s.stage.blenderDir}/rgb/frame_0001.png`, s.updated_at)}
                      alt={`${s.shot_key}, first frame`}
                    />
                  )}
                  <p className="empty">
                    {c?.lens_mm} mm · {ch ? `${ch.display} on ${ch.mark.replace(/^ANCHOR_/, '')}, ` : ''}
                    {c?.azimuth_deg_from_character ?? 0}° at {c?.start_distance_m} m · {s.shot.clock?.frames} frames
                  </p>
                  {s.visibility && <VisibilityBadges v={s.visibility} />}
                  {s.error_message && <p className="error">{s.error_message}</p>}
                  <div className="edit-ref-actions">
                    {s.stage?.plates && (
                      <button type="button" onClick={() => setOpenPlates(openPlates === s.id ? null : s.id)}>
                        {openPlates === s.id ? 'Hide plates' : 'Plates'}
                      </button>
                    )}
                    {s.scout_sheet && (
                      <button type="button" onClick={() => setSheet(s.scout_sheet)}>Scout sheet</button>
                    )}
                    <button type="button" className="danger" onClick={() => handleRemove(s)}>Remove</button>
                  </div>
                  {openPlates === s.id && s.stage?.plates && (
                    <div className="sets-plates">
                      {s.stage.plates.plates.map((p) => (
                        <img
                          key={p.camera}
                          src={setsView(`${s.stage!.blenderDir}/plates/${p.camera}.png`, s.updated_at)}
                          alt={`Plate ${p.camera}, ${p.lens_mm} mm`}
                          title={`${p.camera} · ${p.lens_mm} mm`}
                        />
                      ))}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        </>
      )}

      {sheet && (
        <>
          <h4>Tech scout</h4>
          <img className="edit-output" src={setsView(sheet)} alt="Tech-scout contact sheet" />
          <div className="edit-ref-actions">
            <button type="button" onClick={() => setSheet(null)}>Close</button>
          </div>
        </>
      )}
    </div>
  )
}
