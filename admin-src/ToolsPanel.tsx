import { useState } from 'react'
import { parseFlowJson, triggerFlow } from './flowise'
import type { Movie } from './insforge'

/**
 * Shot breakdown: a finished film in, its shot list out.
 *
 * You have the real Twin Pines Mall sequence and you want to know how it was
 * SHOT - where the camera was, how close, who was in frame, what they were doing.
 * That is the part nobody can write from memory, and it is sitting in the film.
 *
 * Every cut is found, the first frame of each shot is pulled, and the vision
 * model is asked what it is looking at. The first frame is the right one to ask
 * about: it is the composition the shot opens on, which is exactly what a frame
 * prompt has to describe.
 *
 * A TOOL, deliberately. It writes nothing to the database and touches no movie.
 * It reads a video and leaves a folder of frames and two files of text; what you
 * do with those - paste into a screenplay, work from them by hand - is yours.
 */
type Shot = {
  shot: number
  start: number
  seconds: number | null
  timecode: string
  frame: string
  lines?: string[]
  description?: {
    size?: string
    angle?: string
    setting?: string
    light?: string
    foreground?: string | null
    people?: { who?: string; doing?: string; where?: string }[]
    objects?: string[]
    frame?: string
  }
  error?: string
}

type Script = {
  action: string
  title: string
  cast: string[]
  textPath: string
  jsonPath: string
  text: string
  scenes: { scene: number; heading: string; beats: number; lines: number }[]
  error?: string
}

type Result = {
  action: string
  count: number
  duration: number | null
  start?: number
  end?: number
  threshold: number
  outDir: string
  markdownPath: string
  shots: Shot[]
  error?: string
}

export function ToolsPanel({ movie }: { movie: Movie | null }) {
  const [videoPath, setVideoPath] = useState('')
  const [threshold, setThreshold] = useState('0.3')
  const [startAt, setStartAt] = useState('')
  const [endAt, setEndAt] = useState('')
  const [describe, setDescribe] = useState(true)
  const [transcribe, setTranscribe] = useState(true)
  const [whisper, setWhisper] = useState('small')
  const [running, setRunning] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<Result | null>(null)
  const [choosing, setChoosing] = useState(false)

  // Opens the real Windows file dialog on the machine Flowise runs on - which is
  // this one. A browser file input cannot give a path, by design; this can,
  // because it is not the browser doing the asking.
  async function chooseFile() {
    const flowId = import.meta.env.VITE_SHOT_BREAKDOWN_ID
    if (!flowId) {
      setError('VITE_SHOT_BREAKDOWN_ID is not set in .env - restart the dev server after adding it.')
      return
    }
    setChoosing(true)
    setError(null)
    const res = parseFlowJson<{ action: string; videoPath?: string; error?: string }>(
      await triggerFlow(flowId, { mode: 'choose' })
    )
    setChoosing(false)
    if (!res.ok) {
      setError(res.message)
      return
    }
    if (res.data.action === 'chose' && res.data.videoPath) setVideoPath(res.data.videoPath)
  }
  // Opens the output folder in Explorer on this machine, for the same reason the
  // file dialog does: the browser cannot, and Flowise is sitting on the machine
  // that can.
  async function openFolder(dir: string) {
    const flowId = import.meta.env.VITE_SHOT_BREAKDOWN_ID
    if (!flowId) return
    const res = parseFlowJson<{ action: string; error?: string }>(await triggerFlow(flowId, { mode: 'reveal', dir }))
    if (!res.ok) setError(res.message)
    else if (res.data.action !== 'revealed') setError(res.data.error ?? res.data.action)
  }
  const [script, setScript] = useState<Script | null>(null)
  const [building, setBuilding] = useState(false)
  const [cast, setCastRaw] = useState(() => {
    try {
      return localStorage.getItem('tools.cast') ?? ''
    } catch (e) {
      return ''
    }
  })
  function setCast(next: string) {
    setCastRaw(next)
    try {
      localStorage.setItem('tools.cast', next)
    } catch (e) {
      /* not remembering is not a failure */
    }
  }
  // The breakdown this builds from. Filled in automatically when one has just
  // run, and choosable otherwise: this section used to live inside the results
  // block, so reloading the page took the button away along with the table, and
  // a breakdown from an hour ago could not be turned into a screenplay at all.
  const REMEMBERED = 'tools.shotsPath'
  const [shotsPath, setShotsPathRaw] = useState(() => {
    try {
      return localStorage.getItem(REMEMBERED) ?? ''
    } catch (e) {
      // Private windows and blocked site data both throw here.
      return ''
    }
  })
  function setShotsPath(next: string) {
    setShotsPathRaw(next)
    try {
      if (next) localStorage.setItem(REMEMBERED, next)
      else localStorage.removeItem(REMEMBERED)
    } catch (e) {
      // Not remembering is a smaller problem than failing to set it.
    }
  }

  // Pick a breakdown with the same dialog that picks a film - it takes a flag
  // that swaps its filter, rather than being a second dialog to keep working.
  async function chooseShots() {
    const flowId = import.meta.env.VITE_SHOT_BREAKDOWN_ID
    if (!flowId) return
    setChoosing(true)
    setError(null)
    const res = parseFlowJson<{ action: string; videoPath?: string }>(
      await triggerFlow(flowId, { mode: 'choose', want: 'shots' })
    )
    setChoosing(false)
    if (!res.ok) {
      setError(res.message)
      return
    }
    if (res.data.action === 'chose' && res.data.videoPath) setShotsPath(res.data.videoPath)
  }

  // Works out who is who and where each place is, groups the shots into scenes
  // and beats, and writes the script beside the breakdown.
  //
  // Its own button rather than part of the breakdown: you look at the shots
  // first, decide the cuts were found properly, and only then ask for a script
  // of them. Running it automatically would mean rebuilding a screenplay every
  // time you retried a threshold.
  async function buildScreenplay() {
    const flowId = import.meta.env.VITE_SHOT_BREAKDOWN_ID
    if (!flowId || !shotsPath.trim()) return
    setBuilding(true)
    setError(null)
    const res = parseFlowJson<Script>(
      await triggerFlow(flowId, {
        mode: 'screenplay',
        shotsJson: shotsPath,
        // The selected movie, so its own characters can name the groups. Without
        // it every person is labelled by what they look like and has to be mapped
        // by hand afterwards.
        movieId: movie ? movie.id : undefined,
        cast: cast.trim(),
        title: shotsPath.split(/[\\/]/).slice(-2, -1)[0] ?? 'Scene'
      })
    )
    setBuilding(false)
    if (!res.ok) {
      setError(res.message)
      return
    }
    if (res.data.action !== 'screenplay') {
      setError(res.data.error ?? res.data.action)
      return
    }
    setScript(res.data)
  }

  const [importing, setImporting] = useState(false)

  // The breakdown, into the movie: its beats AND a director plan carrying the
  // real coverage, cut for cut.
  //
  // Without this the shot detail died at the boundary - the beats reached the
  // pipeline and every size, foreground and duration the breakdown found was
  // thrown away, leaving the Director to invent its own coverage from the beat
  // prose. Which is the opposite of why anyone breaks a film down.
  async function importToMovie() {
    const flowId = import.meta.env.VITE_IMPORT_BREAKDOWN_ID
    if (!flowId) {
      setError('VITE_IMPORT_BREAKDOWN_ID is not set in .env - restart the dev server after adding it.')
      return
    }
    if (!movie || !script) return
    setImporting(true)
    setError(null)
    const res = parseFlowJson<{
      action: string
      counts?: Record<string, unknown>
      notes?: string[]
      note?: string
      error?: string
    }>(
      await triggerFlow(flowId, { movieId: movie.id, screenplayJson: script.jsonPath, what: 'both' })
    )
    setImporting(false)
    if (!res.ok) {
      setError(res.message)
      return
    }
    if (res.data.action !== 'imported') {
      setError(res.data.error ?? res.data.action)
      return
    }
    setError([res.data.note, ...(res.data.notes ?? [])].filter(Boolean).join(' '))
  }
  // Saved from the text the flow returned, not read off the disk: a browser
  // cannot open a file on this machine, but it can save one it was handed.
  function downloadScreenplay() {
    if (!script?.text) return
    const blob = new Blob([script.text], { type: 'text/plain;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${(script.title || 'screenplay').replace(/[^\w. -]+/g, '')}.txt`
    document.body.appendChild(a)
    a.click()
    a.remove()
    URL.revokeObjectURL(url)
  }

  async function run(e: React.FormEvent) {
    e.preventDefault()
    const flowId = import.meta.env.VITE_SHOT_BREAKDOWN_ID
    if (!flowId) {
      setError('VITE_SHOT_BREAKDOWN_ID is not set in .env - restart the dev server after adding it.')
      return
    }
    if (!videoPath.trim()) {
      setError('Give the path to a video file on this machine.')
      return
    }
    setRunning(true)
    setError(null)
    setResult(null)
    setScript(null)
    const res = parseFlowJson<Result>(
      await triggerFlow(flowId, {
        videoPath: videoPath.trim(),
        start: startAt.trim(),
        end: endAt.trim(),
        threshold: Number(threshold) || 0.3,
        describe,
        transcribe,
        model: whisper
      })
    )
    setRunning(false)
    if (!res.ok) {
      setError(res.message)
      return
    }
    if (res.data.action !== 'broken_down') {
      setError(res.data.error ?? res.data.action)
      return
    }
    setResult(res.data)
    setShotsPath(res.data.outDir + String.fromCharCode(92) + 'shots.json')
  }

  return (
    <div>
      <p>
        Tools that sit beside the pipeline rather than in it. Nothing here writes to a movie.
      </p>

      <h3>Shot breakdown</h3>
      <p className="empty">
        Point it at a film and it finds every cut, pulls the first frame of each shot and describes what is in
        it — size, angle, who is in frame and where, the setting, the light and anything in the foreground.
        That is a shot list of a film that already exists, to write your own against.
      </p>

      <form className="upload-form" onSubmit={run}>
        <input
          type="text"
          style={{ minWidth: '28rem' }}
          placeholder="C:/video/mall-scene.mp4"
          value={videoPath}
          onChange={(e) => setVideoPath(e.target.value)}
          disabled={running}
        />
        <button type="button" onClick={chooseFile} disabled={running || choosing}>
          {choosing ? 'Choose a file…' : 'Choose file'}
        </button>
        <label title="Where in the film to start. Seconds, or mm:ss, or hh:mm:ss — whichever the player gives you. Leave both blank for the whole thing.">
          <span>From </span>
          <input
            type="text"
            style={{ width: '6rem' }}
            placeholder="40:00"
            value={startAt}
            onChange={(e) => setStartAt(e.target.value)}
            disabled={running}
          />
        </label>
        <label title="Where to stop. Leave blank to run to the end of the film.">
          <span>to </span>
          <input
            type="text"
            style={{ width: '6rem' }}
            placeholder="44:30"
            value={endAt}
            onChange={(e) => setEndAt(e.target.value)}
            disabled={running}
          />
        </label>
        <label title="How different two frames must be to count as a cut. Lower finds more cuts, higher finds fewer. 0.3 is a sensible start; drop it for a film that cuts inside one continuous scene, raise it for heavy motion.">
          <span>Cut sensitivity </span>
          <input
            type="number"
            step={0.05}
            min={0.05}
            max={0.95}
            style={{ width: '5rem' }}
            value={threshold}
            onChange={(e) => setThreshold(e.target.value)}
            disabled={running}
          />
        </label>
        <label>
          <input type="checkbox" checked={describe} onChange={(e) => setDescribe(e.target.checked)} disabled={running} />
          <span>Describe each shot</span>
        </label>
        <label title="Transcribes the audio and gives each shot the words spoken over it, split at the cuts.">
          <input
            type="checkbox"
            checked={transcribe}
            onChange={(e) => setTranscribe(e.target.checked)}
            disabled={running}
          />
          <span>Transcribe</span>
        </label>
        {transcribe && (
          <select value={whisper} onChange={(e) => setWhisper(e.target.value)} disabled={running} title="base is quick and good enough to recognise a line you already know. small is noticeably better on overlapping speech and room noise, at roughly three times the time.">
            <option value="base">base (quick)</option>
            <option value="small">small (better)</option>
            <option value="medium">medium (slow, downloads first)</option>
          </select>
        )}
        <button type="submit" className="primary" disabled={running}>
          {running ? 'Working…' : 'Break it down'}
        </button>
      </form>
      <p className="empty">
        The path is read by the machine Flowise runs on, not by the browser — so it is a path on this computer,
        not an upload. Describing is one vision call per shot, so a long film takes a while; untick it to get the
        cuts and frames quickly and describe them later.
      </p>

      {error && <p className="error">{error}</p>}

      {result && (
        <>
          <p>
            <strong>{result.count} shots</strong>
            {result.start ? ` from ${startAt || result.start}` : ''}
            {result.end && result.start ? ` to ${endAt || result.end}` : ''}
            {result.duration ? ` in ${result.duration.toFixed(1)}s` : ''} at sensitivity {result.threshold}. Frames
            and text written to <code>{result.outDir}</code>.
          </p>
          <p>
            <button type="button" onClick={() => void openFolder(result.outDir)}>
              Open the folder
            </button>{' '}
            <span className="empty">
              shots.md is the readable breakdown, shots.json the same thing structured, and frames/ holds one
              picture per shot.
            </span>
          </p>
          <p className="empty">
            If the count looks wrong, change the sensitivity and run it again — it is the one number that decides
            what counts as a cut.
          </p>
          <table className="data-table">
            <thead>
              <tr>
                <th>#</th>
                <th>At</th>
                <th>Held</th>
                <th>Size</th>
                <th>In frame</th>
                <th>The shot</th>
                <th>Said over it</th>
              </tr>
            </thead>
            <tbody>
              {result.shots.map((s) => {
                const d = s.description ?? {}
                return (
                  <tr key={s.shot}>
                    <td>{s.shot}</td>
                    <td>{s.timecode}</td>
                    <td>{s.seconds ? `${s.seconds}s` : '—'}</td>
                    <td>{d.size ?? '—'}</td>
                    <td>
                      {(d.people ?? []).length
                        ? (d.people ?? []).map((p) => `${p.who} (${p.where})`).join('; ')
                        : '—'}
                    </td>
                    <td>
                      {d.frame ?? (s.error ? <span className="error">{s.error}</span> : '—')}
                      {d.setting && <div className="empty">{d.setting}</div>}
                    </td>
                    <td>{(s.lines ?? []).length ? (s.lines ?? []).join(' ') : <span className="empty">—</span>}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>

            </>
          )}

        <h3>Screenplay</h3>
        <p className="empty">
          Works out who is who, groups the shots into scenes by place and into beats by where the talking
          starts and stops, and writes it in the shape this pipeline's beats take. Speaker cues come out as
          ??? — who says what is the one thing the pictures and the audio together cannot settle.
        </p>
        <form
          className="upload-form"
          onSubmit={(e) => {
            e.preventDefault()
            void buildScreenplay()
          }}
        >
          <input
            type="text"
            style={{ minWidth: '22rem' }}
            placeholder="Optional: a character=red puffer vest, BROWN=white hair"
            value={cast}
            onChange={(e) => setCast(e.target.value)}
            disabled={building}
            title="You know the cast; this only has pictures. Give a name and any words that appear in that person's descriptions, and it will be used instead of a made-up label."
          />
          <button type="button" onClick={chooseShots} disabled={building || choosing}>
            {shotsPath ? 'Change breakdown' : 'Choose breakdown…'}
          </button>
          <button type="submit" className="primary" disabled={building || !shotsPath.trim()}>
            {building ? 'Building…' : 'Build screenplay'}
          </button>
          {script && (
            <button type="button" onClick={downloadScreenplay}>
              Download screenplay
            </button>
          )}
          {script && movie && (
            <button
              type="button"
              onClick={importToMovie}
              disabled={importing}
              title="Writes the beats and a shot plan into this movie. The plan carries the coverage this film used - sizes, foregrounds, how long each shot holds - and the prompts are rebuilt from your own cast, props and wardrobe."
            >
              {importing ? `Importing…` : `Send to ${movie.title}`}
            </button>
          )}
        </form>
        <p className="empty">
          {shotsPath ? (
            <>
              Building from <code>{shotsPath}</code>
            </>
          ) : (
            'Run a breakdown above, or choose the shots.json of one you ran earlier.'
          )}
        </p>

        {script && (
          <>
            <p>
              <strong>{script.cast.join(', ')}</strong> in {script.scenes.length} scene
              {script.scenes.length === 1 ? '' : 's'}, written to <code>{script.textPath}</code>.
            </p>
            <table className="data-table">
              <thead>
                <tr>
                  <th>#</th>
                  <th>Heading</th>
                  <th>Beats</th>
                  <th>Lines</th>
                </tr>
              </thead>
              <tbody>
                {script.scenes.map((sc) => (
                  <tr key={sc.scene}>
                    <td>{sc.scene}</td>
                    <td>{sc.heading}</td>
                    <td>{sc.beats}</td>
                    <td>{sc.lines}</td>
                  </tr>
                ))}
              </tbody>
            </table>
        </>
      )}
    </div>
  )
}
