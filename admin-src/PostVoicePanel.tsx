import { useEffect, useState } from 'react'
import { Select } from './ui/Select'
import { insforge, comfyViewUrl, type Movie, type MinimaxClip } from './insforge'
import { triggerFlow, type RunStatus } from './flowise'
import { uploadToMovie } from './storage'

// Voices are replaced AFTER rendering, not during it. MiniMax bakes dialogue,
// music and SFX into one track and animates the mouth to its own voice, so the
// job is: split the mix, re-voice only the vocal, put it back over the same bed.
// Speech-to-speech keeps the original timing, so lip-sync survives - which
// text-to-speech could never do.
type Voice = { id: string; name: string; gender: string; accent: string }

type Replacement = {
  id: string
  movie_id: string
  clip_id: string | null
  voice_id: string
  voice_name: string | null
  gain: number
  status: string
  output_path: string | null
  source_filename: string | null
  timing_match: number | null
  error_message: string | null
  created_at: string
}

export function PostVoicePanel({ movie }: { movie: Movie }) {
  const [clips, setClips] = useState<MinimaxClip[]>([])
  const [clipId, setClipId] = useState('')
  // Either a clip this project rendered, or any video file off disk.
  const [source, setSource] = useState<'clip' | 'file'>('clip')
  const [file, setFile] = useState<File | null>(null)
  const [fileUrl, setFileUrl] = useState('')
  const [voices, setVoices] = useState<Voice[]>([])
  const [voiceId, setVoiceId] = useState('')
  const [gain, setGain] = useState(2)
  const [rows, setRows] = useState<Replacement[]>([])
  const [status, setStatus] = useState<RunStatus | null>(null)
  const [loadingVoices, setLoadingVoices] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const flowId = import.meta.env.VITE_POST_VOICE_ID
  const clip = clips.find((c) => c.id === clipId)

  async function loadClips() {
    const { data, error: e } = await insforge.database
      .from('minimax_clips')
      .select('*')
      .eq('movie_id', movie.id)
      .eq('status', 'complete')
      .order('created_at', { ascending: false })
    if (e) setError(e.message)
    else {
      const withVideo = ((data ?? []) as MinimaxClip[]).filter((c) => c.video_path)
      setClips(withVideo)
      setClipId((prev) => prev || (withVideo[0]?.id ?? ''))
    }
  }

  async function loadRows() {
    const { data } = await insforge.database
      .from('voice_replacements')
      .select('*')
      .eq('movie_id', movie.id)
      .order('created_at', { ascending: false })
    setRows((data ?? []) as Replacement[])
  }

  // The ElevenLabs key lives server-side, so the voice list comes back through
  // the flow rather than the browser calling ElevenLabs itself.
  async function loadVoices() {
    setLoadingVoices(true)
    const result = await triggerFlow(flowId, { action: 'voices' })
    setLoadingVoices(false)
    if (result.state === 'error') {
      setError(result.message)
      return
    }
    try {
      const payload = JSON.parse(result.message)
      if (payload.error) {
        setError(payload.error)
        return
      }
      const list = (payload.voices ?? []) as Voice[]
      setVoices(list)
      setVoiceId((prev) => prev || (list[0]?.id ?? ''))
    } catch {
      setError('Could not read the voice list.')
    }
  }

  useEffect(() => {
    loadClips()
    loadRows()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [movie.id])

  useEffect(() => {
    loadVoices()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Show the picked file before spending a job on it.
  useEffect(() => {
    if (!file) {
      setFileUrl('')
      return
    }
    const url = URL.createObjectURL(file)
    setFileUrl(url)
    return () => URL.revokeObjectURL(url)
  }, [file])

  async function handleReplace() {
    if (!voiceId) return
    if (source === 'clip' && !clipId) return
    if (source === 'file' && !file) return
    setError(null)
    setStatus({ state: 'running', message: '' })
    const voice = voices.find((v) => v.id === voiceId)

    // An uploaded file goes to the movie's bucket first; the flow pulls it back
    // down server-side, so the browser never has to reach the worker directly.
    let sourceKey: string | null = null
    if (source === 'file' && file) {
      setStatus({ state: 'running', message: 'Uploading the video…' })
      const up = await uploadToMovie(movie, 'post-voice-src', file)
      if ('error' in up) {
        setStatus({ state: 'error', message: up.error })
        return
      }
      sourceKey = up.key
    }

    const { data: inserted, error: insertError } = await insforge.database
      .from('voice_replacements')
      .insert([
        {
          movie_id: movie.id,
          clip_id: source === 'clip' ? clipId : null,
          source_key: sourceKey,
          source_filename: source === 'file' && file ? file.name : null,
          voice_id: voiceId,
          voice_name: voice?.name ?? null,
          gain,
          status: 'queued'
        }
      ])
      .select()
    if (insertError) {
      setStatus({ state: 'error', message: insertError.message })
      return
    }
    let row = (inserted ?? [])[0] as Replacement | undefined
    if (!row) {
      const { data: recent } = await insforge.database
        .from('voice_replacements')
        .select('*')
        .eq('movie_id', movie.id)
        .order('created_at', { ascending: false })
        .limit(1)
      row = ((recent ?? []) as Replacement[])[0]
    }
    if (!row) {
      setStatus({ state: 'error', message: 'Row could not be read back after insert.' })
      return
    }

    await loadRows()
    setStatus({
      state: 'done',
      message: 'Working — separation loads a large model, so the first run takes a few minutes. Click Refresh to check.'
    })
    triggerFlow(flowId, { action: 'convert', replacementId: row.id }).then((result) => {
      setStatus(result)
      loadRows()
    })
  }

  const label = (c: MinimaxClip) =>
    `${c.mode} · ${c.length}f · ${c.width}x${c.height} · ${c.id.slice(0, 8)}`

  return (
    <div>
      {error && <p className="error">{error}</p>}
      <h3>Post Voice (ElevenLabs)</h3>
      <p className="empty">
        Replaces the voice in a clip that has already rendered — nothing is re-generated, so this costs no GPU time and
        takes seconds of compute rather than minutes. The clip's music and sound effects are kept exactly as they were:
        only the voice is swapped. Because the conversion follows the original delivery rather than reading the line
        afresh, the lip-sync still matches.
      </p>

      <h4>Video</h4>
      <div className="upload-form">
        <label>
          <input type="radio" name="pv-source" checked={source === 'clip'} onChange={() => setSource('clip')} /> A clip
          from this project
        </label>
        <label>
          <input type="radio" name="pv-source" checked={source === 'file'} onChange={() => setSource('file')} /> A file
          from my computer
        </label>
      </div>

      {source === 'clip' ? (
        <>
          {clips.length === 0 && <p className="empty">No finished clips with video for {movie.title} yet.</p>}
          <div className="upload-form">
            <Select
              value={clipId}
              onValueChange={setClipId}
              placeholder="Choose a clip"
              items={clips.map((c) => ({ value: c.id, label: label(c) }))}
            />
          </div>
          {clip?.video_path && (
            <>
              <video className="shot-preview" src={comfyViewUrl(clip.video_path)} controls preload="metadata" />
              <p className="empty">{clip.prompt.slice(0, 200)}</p>
            </>
          )}
        </>
      ) : (
        <>
          <div className="upload-form">
            <input type="file" accept="video/*" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
          </div>
          <p className="empty">
            Any video with a voice on it works — it does not have to come from this pipeline. It needs an audio track;
            a silent clip has nothing to separate.
          </p>
          {fileUrl && <video className="shot-preview" src={fileUrl} controls preload="metadata" />}
          {file && <p className="empty">{file.name}</p>}
        </>
      )}

      <h4>Voice</h4>
      <div className="upload-form">
        <Select
          value={voiceId}
          onValueChange={setVoiceId}
          placeholder={loadingVoices ? 'Loading…' : 'No voices loaded'}
          items={voices.map((v) => ({
            value: v.id,
            label: v.name + (v.gender ? ` — ${v.gender}${v.accent ? ', ' + v.accent : ''}` : '')
          }))}
        />
        <button type="button" onClick={loadVoices} disabled={loadingVoices}>
          {loadingVoices ? 'Loading…' : 'Reload voices'}
        </button>
      </div>
      <label className="empty">
        Voice level{' '}
        <input
          type="number"
          step={0.5}
          min={0.5}
          max={6}
          value={gain}
          onChange={(e) => setGain(Number(e.target.value))}
        />{' '}
        — conversions come back quieter than the original, so this lifts the voice back over the bed. Raise it if the
        voice sits under the music.
      </label>

      <div className="upload-form">
        <button
          type="button"
          disabled={
            status?.state === 'running' || !voiceId || (source === 'clip' ? !clipId : !file)
          }
          onClick={handleReplace}
        >
          {status?.state === 'running' ? 'Working…' : 'Replace voice'}
        </button>
        <button type="button" onClick={loadRows}>
          Refresh
        </button>
      </div>
      {status && status.state !== 'running' && (
        <p className={status.state === 'error' ? 'error' : 'run-status-ok'}>{status.message}</p>
      )}

      <h4>Replacements</h4>
      {rows.length === 0 && <p className="empty">Nothing replaced yet for {movie.title}.</p>}
      {rows.map((r) => (
        <div className="beat-card" key={r.id}>
          <div className="take-head">
            <strong>{r.voice_name ?? r.voice_id}</strong>
            <span className="badge">{r.status}</span>
            {r.timing_match !== null && (
              <span className="badge" title="1.00 means the new voice lands every syllable exactly where the original did">
                timing {r.timing_match.toFixed(3)}
              </span>
            )}
            <span className="badge">
              from {r.source_filename ? r.source_filename : (r.clip_id ?? '').slice(0, 8)}
            </span>
          </div>
          {r.error_message && <p className="error">{r.error_message}</p>}
          {r.output_path && (
            <>
              <video className="shot-preview" src={comfyViewUrl(r.output_path)} controls preload="metadata" />
              <p className="empty">{r.output_path}</p>
            </>
          )}
        </div>
      ))}
    </div>
  )
}
