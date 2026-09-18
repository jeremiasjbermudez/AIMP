import { useEffect, useState } from 'react'
import { Select } from './ui/Select'
import { insforge, comfyViewUrl, type Movie, type MinimaxClip, type Beat } from './insforge'
import { triggerFlow, type RunStatus } from './flowise'
import { uploadToMovie } from './storage'
import { deleteAssetFiles, deleteStorageObjects, keptNote } from './assets'

// Score lives here, not in the clips.
//
// MiniMax H3 writes each clip's audio independently, so music generated inside
// clips cannot match across a cut - a different key, tempo and instrumentation
// every time. The beat prompt therefore sends non_diegetic_music: N/A, leaving
// H3 to produce room tone and effects only, and the score is generated once
// here for a whole scene and laid under the edit.
type Score = {
  id: string
  movie_id: string
  title: string | null
  generator: string
  prompt: string
  duration_seconds: number
  seed: number
  source_clip_id: string | null
  source_filename: string | null
  status: string
  audio_path: string | null
  source_key: string | null
  error_message: string | null
  created_at: string
  // ACE-Step 1.5 fields. Present so a cue can be re-rendered with fresh seeds
  // without losing the musical parameters it was written for.
  lyrics: string | null
  bpm: number | null
  keyscale: string | null
  timesignature: string | null
  language: string | null
  reference_audio_key: string | null
  reference_audio_filename: string | null
}

// MiniMax Music 3 wants a long, sectioned brief - the model card names the
// three sections explicitly: Global Metadata, Vocal Details, Arrangement. A
// terse prompt gives it nothing to sustain and it emits an end-of-audio token
// almost immediately, which is how a 60s request came back as 7s of humming.
//
// These are FILLED examples, not skeletons. An earlier version handed over
// bracketed placeholders and they went to the model verbatim, producing music
// that had nothing to do with what was asked for.
const CAPTION_PRESETS: { id: string; label: string; caption: string }[] = [
  { id: "tense", label: "Tense underscore", caption: "Global Metadata: Dark ambient score, cinematic underscore. 70 BPM, C minor, natural minor. Opens sparse and uneasy, tightens through the middle with slow rising pressure, resolves into an unsettled hush. Heard under a quiet scene where something is wrong. Clean modern film mix, wide stereo, deep sub weight, long tails, no harshness.\n\nVocal Details: Instrumental, no vocals, no vocal samples.\n\nArrangement: Low sustained synth pad and bowed double bass hold the floor, a single detuned piano note repeats irregularly, distant metallic scrapes and filtered noise swells enter halfway, soft timpani pulse builds under the last third, everything decays into a low drone." },
  { id: "drop", label: "K-pop / trap with a drop", caption: "Global Metadata: K-pop dance-pop with trap hip-hop production. 128 BPM, F minor, natural minor. Restrained tense build for the first twenty seconds, hard bass drop, then driving and confident to the end. Neon night-drive energy. Polished modern commercial mix, heavy sub-bass, crisp transients, wide stereo synths.\n\nVocal Details: Instrumental, no vocals, no vocal samples.\n\nArrangement: Filtered synth pluck intro over a rising riser and snare roll, 808 sub-bass and fast trap hats land at the drop, detuned saw-lead hook over sidechained chords, brief half-time breakdown, final section returns with added layers." },
  { id: "warm", label: "Warm and hopeful", caption: "Global Metadata: Cinematic ambient folk. 84 BPM, D major, major scale. Gentle and open from the start, gathering warmth through the middle, settling softly at the close. Heard under a quiet hopeful moment. Natural intimate recording, warm analogue texture, light tape saturation, generous room reverb.\n\nVocal Details: Instrumental, no vocals, no vocal samples.\n\nArrangement: Fingerpicked nylon guitar carries the melody, soft felt piano answers it, warm upright bass underneath, brushed drums enter halfway and stay light, a string pad swells gently in the final third and fades." },
]

const PLACEHOLDER_RE = /\[[^\]]{3,}\]/

// The node's own enums, mirrored so the picker cannot offer a value ComfyUI
// would reject.
const KEYSCALES = ['major', 'minor'].flatMap((quality) =>
  ['C', 'C#', 'Db', 'D', 'D#', 'Eb', 'E', 'F', 'F#', 'Gb', 'G', 'G#', 'Ab', 'A', 'A#', 'Bb', 'B'].map(
    (root) => `${root} ${quality}`
  )
)

const ACE_LANGUAGES = [
  'en', 'es', 'fr', 'de', 'it', 'pt', 'nl', 'pl', 'ru', 'uk', 'sv', 'no', 'da', 'fi', 'is', 'cs',
  'sk', 'hu', 'ro', 'bg', 'hr', 'sr', 'ca', 'la', 'tr', 'az', 'ar', 'he', 'fa', 'ur', 'hi', 'bn',
  'pa', 'ne', 'sa', 'ta', 'te', 'th', 'vi', 'id', 'ms', 'tl', 'ht', 'sw', 'lt', 'ja', 'ko', 'zh',
  'yue', 'el', 'unknown'
]

const GENERATORS = [
  {
    id: 'ace_step_15_xl',
    label: 'ACE-Step 1.5 XL-SFT (local, best quality)',
    hint:
      'The 4B decoder, fine-tuned, at the full 50 diffusion steps with CFG on — the highest-quality option and several times slower than turbo. Worth it for a cue you are keeping.'
  },
  {
    id: 'ace_step_15',
    label: 'ACE-Step 1.5 turbo (local, fast)',
    hint:
      'Runs on your own GPU. An LM plans the song before a diffusion decoder renders it, and it takes BPM, key and time signature as real parameters rather than reading them out of prose — so the caption’s "120 BPM, C minor" is honoured exactly. Turbo is distilled: 8 steps, so a cue renders quickly.'
  },
  {
    id: 'sonilo_text',
    label: 'MiniMax Music 3 (local)',
    hint:
      'Runs on your own GPU. Up to 5 minutes in one pass, with optional lyrics. Built for songs with vocals — for an instrumental bed, say so in the description and use [Instrumental] in the lyrics box.'
  },
  {
    id: 'sonilo_video',
    label: 'Sonilo, to picture (cloud)',
    hint:
      'Watches a video and writes music that follows it. Runs on comfy.org, and its login only exists inside the ComfyUI web page — so this will fail from here. Use the ComfyUI UI for it until that changes.'
  }
]

/** One cue the agent proposed. Mirrors the flow's output shape. */
type Proposal = {
  title: string
  function: string
  mood: string
  arc: string
  instrumentation: string
  era: string
  bpm: number
  keyscale: string
  timesignature: string
  caption: string
  note: string
}

/** Both ACE-Step variants share every control; only the loaders differ. */
function isAce(g: string) {
  return g === 'ace_step_15' || g === 'ace_step_15_xl'
}

export function ScorePanel({ movie }: { movie: Movie }) {
  const [rows, setRows] = useState<Score[]>([])
  const [clips, setClips] = useState<MinimaxClip[]>([])
  const [generator, setGenerator] = useState('ace_step_15')
  const [title, setTitle] = useState('')
  const [prompt, setPrompt] = useState('')
  const [duration, setDuration] = useState(60)
  // ACE-Step 1.5 takes these as real parameters. Empty means "read it out of
  // the caption", which the caption generator always commits to - these exist
  // to override a bad parse or to set something the caption never mentioned.
  const [bpm, setBpm] = useState('')
  const [keyscale, setKeyscale] = useState('')
  const [timesig, setTimesig] = useState('')
  const [language, setLanguage] = useState('en')
  const [refAudio, setRefAudio] = useState<File | null>(null)
  const [takeCount, setTakeCount] = useState(1)
  // The agent's proposals. Nothing is written until one is used.
  const [beats, setBeats] = useState<Beat[]>([])
  const [agentBeatId, setAgentBeatId] = useState('')
  const [proposals, setProposals] = useState<Proposal[]>([])
  const [agentStatus, setAgentStatus] = useState<RunStatus | null>(null)
  const [lyrics, setLyrics] = useState('')
  const [clipId, setClipId] = useState('')
  // Clip ids are hard to recognise in a dropdown, so a file off disk is often
  // the clearer way to say which cut to score.
  const [videoSource, setVideoSource] = useState<'clip' | 'file'>('file')
  const [file, setFile] = useState<File | null>(null)
  const [fileUrl, setFileUrl] = useState('')
  const [status, setStatus] = useState<RunStatus | null>(null)
  const [enhanceStatus, setEnhanceStatus] = useState<RunStatus | null>(null)
  const [error, setError] = useState<string | null>(null)

  const flowId = import.meta.env.VITE_SCORE_ID

  async function loadBeats() {
    const { data } = await insforge.database
      .from('beats')
      .select('id,beat_code,summary')
      .eq('movie_id', movie.id)
      .order('sequence_index', { ascending: true })
    setBeats((data ?? []) as Beat[])
  }

  /** Ask the agent for contrasting cues for one beat. Proposals only. */
  async function handleSuggest() {
    if (!agentBeatId) return
    setProposals([])
    setAgentStatus({ state: 'running', message: '' })
    const r = await triggerFlow(import.meta.env.VITE_SCORE_AGENT_ID, { beatId: agentBeatId, takes: 4 })
    if (r.state === 'error') {
      setAgentStatus(r)
      return
    }
    try {
      const p = JSON.parse(r.message)
      if (p.action !== 'complete') {
        setAgentStatus({ state: 'error', message: p.error ?? 'The agent returned nothing usable.' })
        return
      }
      setProposals(p.proposals as Proposal[])
      setAgentStatus({ state: 'done', message: `${p.count} cues for ${p.beatCode ?? 'this beat'}.` })
    } catch {
      setAgentStatus({ state: 'error', message: r.message })
    }
  }

  /** Load a proposal into the form, ready to generate or edit. */
  function useProposal(p: Proposal) {
    setTitle(p.title)
    setPrompt(p.caption)
    setBpm(String(p.bpm))
    setKeyscale(p.keyscale)
    setTimesig(p.timesignature)
    setLyrics('')
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  async function loadRows() {
    const { data, error: e } = await insforge.database
      .from('scores')
      .select('*')
      .eq('movie_id', movie.id)
      .order('created_at', { ascending: false })
    if (e) setError(e.message)
    else setRows((data ?? []) as Score[])
  }

  async function loadClips() {
    const { data } = await insforge.database
      .from('minimax_clips')
      .select('*')
      .eq('movie_id', movie.id)
      .eq('status', 'complete')
      .order('created_at', { ascending: false })
    const withVideo = ((data ?? []) as MinimaxClip[]).filter((c) => c.video_path)
    setClips(withVideo)
    setClipId((prev) => prev || (withVideo[0]?.id ?? ''))
  }

  useEffect(() => {
    loadBeats()
    loadRows()
    loadClips()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [movie.id])

  // Show the picked file before spending a generation on it.
  useEffect(() => {
    if (!file) {
      setFileUrl('')
      return
    }
    const url = URL.createObjectURL(file)
    setFileUrl(url)
    return () => URL.revokeObjectURL(url)
  }, [file])

  async function handleGenerate() {
    if (!prompt.trim()) return
    // An earlier version let a bracketed skeleton go straight to the model.
    if (generator === 'sonilo_text' && PLACEHOLDER_RE.test(prompt)) {
      setStatus({
        state: 'error',
        message:
          'The caption still contains [placeholders]. Replace them with real values — the model reads them literally.'
      })
      return
    }
    if (generator === 'sonilo_video' && videoSource === 'clip' && !clipId) return
    if (generator === 'sonilo_video' && videoSource === 'file' && !file) return
    setError(null)
    setStatus({ state: 'running', message: '' })

    let sourceKey: string | null = null
    if (generator === 'sonilo_video' && videoSource === 'file' && file) {
      setStatus({ state: 'running', message: 'Uploading the video…' })
      const up = await uploadToMovie(movie, 'score-src', file)
      if ('error' in up) {
        setStatus({ state: 'error', message: up.error })
        return
      }
      sourceKey = up.key
    }

    let refKey: string | null = null
    if (isAce(generator) && refAudio) {
      setStatus({ state: 'running', message: 'Uploading the reference track…' })
      const up = await uploadToMovie(movie, 'score-ref', refAudio)
      if ('error' in up) {
        setStatus({ state: 'error', message: up.error })
        return
      }
      refKey = up.key
    }

    // One row per take. The only thing that differs is the seed - same caption,
    // same key, same tempo - which is the cheapest useful variation there is:
    // the model reads an identical brief and interprets it differently.
    const seeds = Array.from({ length: takeCount }, () =>
      takeCount === 1 ? 0 : Math.floor(Math.random() * 2_000_000_000)
    )
    const { data: inserted, error: insertError } = await insforge.database
      .from('scores')
      .insert(
        seeds.map((s, i) => ({
          movie_id: movie.id,
          title: takeCount > 1 ? `${title.trim() || 'Take'} ${i + 1}` : title.trim() || null,
          generator,
          prompt,
          duration_seconds: duration,
          lyrics: lyrics.trim() || null,
          seed: s,
          reference_audio_key: refKey,
          reference_audio_filename: isAce(generator) && refAudio ? refAudio.name : null,
          bpm: isAce(generator) && bpm ? Number(bpm) : null,
          keyscale: isAce(generator) && keyscale ? keyscale : null,
          timesignature: isAce(generator) && timesig ? timesig : null,
          language: isAce(generator) ? language : null,
          source_clip_id: generator === 'sonilo_video' && videoSource === 'clip' ? clipId : null,
          source_key: sourceKey,
          source_filename: generator === 'sonilo_video' && file ? file.name : null,
          status: 'queued'
        }))
      )
      .select()
    if (insertError) {
      setStatus({ state: 'error', message: insertError.message })
      return
    }
    let rows = (inserted ?? []) as Score[]
    if (!rows.length) {
      const { data: recent } = await insforge.database
        .from('scores')
        .select('*')
        .eq('movie_id', movie.id)
        .order('created_at', { ascending: false })
        .limit(takeCount)
      rows = (recent ?? []) as Score[]
    }
    if (!rows.length) {
      setStatus({ state: 'error', message: 'Score row could not be read back after insert.' })
      return
    }

    await loadRows()
    setStatus({
      state: 'done',
      message:
        rows.length > 1
          ? `Generating ${rows.length} takes — they render one at a time. Click Refresh to check.`
          : 'Generating — longer pieces take a few minutes. Click Refresh to check.'
    })

    // Fired in sequence, not in parallel: ComfyUI renders one at a time anyway,
    // and awaiting each means the list fills in as they land rather than all at
    // the end.
    void (async () => {
      for (const r of rows) {
        const result = await triggerFlow(flowId, { scoreId: r.id })
        setStatus(result)
        await loadRows()
      }
    })()
  }

  /** Same brief, fresh seeds - more readings of a cue that is already close. */
  async function handleMoreTakes(row: Score) {
    setError(null)
    setStatus({ state: 'running', message: '' })
    const seeds = Array.from({ length: 3 }, () => Math.floor(Math.random() * 2_000_000_000))
    const { data: made, error: insErr } = await insforge.database
      .from('scores')
      .insert(
        seeds.map((s, i) => ({
          movie_id: movie.id,
          title: `${row.title ?? 'Cue'} — take ${i + 2}`,
          generator: row.generator,
          prompt: row.prompt,
          duration_seconds: row.duration_seconds,
          lyrics: row.lyrics,
          seed: s,
          bpm: row.bpm,
          keyscale: row.keyscale,
          timesignature: row.timesignature,
          language: row.language,
          reference_audio_key: row.reference_audio_key,
          reference_audio_filename: row.reference_audio_filename,
          status: 'queued'
        }))
      )
      .select()
    if (insErr) {
      setStatus({ state: 'error', message: insErr.message })
      return
    }
    await loadRows()
    setStatus({ state: 'done', message: '3 more takes queued.' })
    void (async () => {
      for (const r of (made ?? []) as Score[]) {
        const result = await triggerFlow(flowId, { scoreId: r.id })
        setStatus(result)
        await loadRows()
      }
    })()
  }

  // Write "kpop" and get the whole three-section brief back. Whether lyrics are
  // present decides whether it writes a vocal description or declares the piece
  // instrumental, so it never invents a singer you did not ask for.
  async function handleEnhance() {
    if (!prompt.trim()) return
    setEnhanceStatus({ state: 'running', message: '' })
    const result = await triggerFlow(flowId, {
      action: 'enhance',
      draft: prompt,
      hasLyrics: !!lyrics.trim()
    })
    if (result.state === 'error') {
      setEnhanceStatus(result)
      return
    }
    try {
      const payload = JSON.parse(result.message)
      if (payload.error) {
        setEnhanceStatus({ state: 'error', message: payload.error })
        return
      }
      setPrompt(payload.caption)
      setEnhanceStatus({
        state: 'done',
        message: `Filled in${payload.hadLyrics ? ' with vocals' : ' as instrumental'} — ${payload.model}. Edit anything you disagree with.`
      })
    } catch {
      setEnhanceStatus({ state: 'error', message: 'Could not read the enhanced caption.' })
    }
  }

  async function handleDelete(row: Score) {
    // Row first, then the rendered audio and the uploaded source, so a deleted
    // score does not leave a .wav behind.
    const { error: delError } = await insforge.database.from('scores').delete().eq('id', row.id)
    if (delError) setError(delError.message)
    else {
      const r = await deleteAssetFiles([row.audio_path])
      await deleteStorageObjects(movie.bucket_name, [row.source_key])
      const note = keptNote(r)
      if (note) setError(note)
      setRows((prev) => prev.filter((x) => x.id !== row.id))
    }
  }

  const gen = GENERATORS.find((g) => g.id === generator)
  const pickedClip = clips.find((c) => c.id === clipId)

  // An id alone is unrecognisable in a list, so lead with when it was made and
  // how long it runs.
  const clipLabel = (c: MinimaxClip) => {
    const when = new Date(c.created_at).toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    })
    return `${when} · ${(c.length / 24).toFixed(1)}s · ${c.mode} · ${c.width}x${c.height} · ${c.id.slice(0, 6)}`
  }

  return (
    <div>
      {error && <p className="error">{error}</p>}
      <h3>Score</h3>
      <p className="empty">
        Music is generated here, once, for a whole scene or sequence — not inside the clips. MiniMax writes each clip's
        audio independently, so music baked into clips changes key and tempo at every cut and can never be made to
        match. Clips are already told not to score themselves; they produce room tone and effects only. This is the
        piece you lay underneath when you assemble the edit.
      </p>

      <h4>How</h4>
      <div className="upload-form">
        {GENERATORS.map((g) => (
          <label key={g.id}>
            <input
              type="radio"
              name="score-generator"
              checked={generator === g.id}
              onChange={() => setGenerator(g.id)}
            />{' '}
            {g.label}
          </label>
        ))}
      </div>
      {gen && <p className="empty">{gen.hint}</p>}

      {generator === 'sonilo_video' && (
        <>
          <div className="upload-form">
            <label>
              <input
                type="radio"
                name="score-video"
                checked={videoSource === 'file'}
                onChange={() => setVideoSource('file')}
              />{' '}
              A file from my computer
            </label>
            <label>
              <input
                type="radio"
                name="score-video"
                checked={videoSource === 'clip'}
                onChange={() => setVideoSource('clip')}
              />{' '}
              A clip from this project
            </label>
          </div>

          {videoSource === 'file' ? (
            <>
              <div className="upload-form">
                <input type="file" accept="video/*" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
              </div>
              {fileUrl && <video className="shot-preview" src={fileUrl} controls preload="metadata" />}
              {file && <p className="empty">{file.name}</p>}
            </>
          ) : (
            <>
              <div className="upload-form">
                <Select
                  value={clipId}
                  onValueChange={setClipId}
                  placeholder={clips.length === 0 ? 'No finished clips yet' : 'Choose a clip'}
                  items={clips.map((c) => ({ value: c.id, label: clipLabel(c) }))}
                />
              </div>
              {pickedClip?.video_path && (
                <video className="shot-preview" src={comfyViewUrl(pickedClip.video_path)} controls preload="metadata" />
              )}
            </>
          )}
          <p className="empty">
            The music follows this video, so its length sets the length of the piece. This is where an assembled cut
            belongs — scoring one shot is rarely what you want.
          </p>
        </>
      )}

      <h4>The music</h4>
      {(generator === 'sonilo_text' || isAce(generator)) && (
        <>
          <div className="upload-form">
            <button
              type="button"
              disabled={enhanceStatus?.state === 'running' || !prompt.trim()}
              onClick={handleEnhance}
            >
              {enhanceStatus?.state === 'running' ? 'Filling in…' : 'Enhance caption'}
            </button>
            <span className="empty">
              Write as little as “kpop” and this fills in tempo, key, mood and arrangement.
            </span>
          </div>
          {enhanceStatus && enhanceStatus.state !== 'running' && (
            <p className={enhanceStatus.state === 'error' ? 'error' : 'run-status-ok'}>{enhanceStatus.message}</p>
          )}
          <div className="upload-form">
            <span className="empty">Or start from a working example:</span>
            {CAPTION_PRESETS.map((c) => (
              <button key={c.id} type="button" onClick={() => setPrompt(c.caption)}>
                {c.label}
              </button>
            ))}
          </div>
          <p className="empty">
            These are complete captions, not templates — edit them rather than filling blanks. The model wants genre,
            BPM, key, a mood arc, production character and a real arrangement; given less, it ends the piece early.
          </p>
        </>
      )}
      <h4>Ask the composer</h4>
      <p className="empty">
        Reads the beat and proposes contrasting cues — function, mood and arc chosen for the scene,
        instrumentation and era varied between takes. The last one is always a deliberate reading
        against the scene.
      </p>
      <div className="upload-form">
        <Select
          value={agentBeatId}
          onValueChange={setAgentBeatId}
          placeholder="Pick a beat…"
          items={beats.map((b) => ({
            value: b.id,
            label: `${b.beat_code ?? '?'} — ${String(b.summary ?? '').slice(0, 60)}`
          }))}
        />
        <button
          type="button"
          disabled={!agentBeatId || agentStatus?.state === 'running'}
          onClick={handleSuggest}
        >
          {agentStatus?.state === 'running' ? 'Thinking…' : 'Suggest cues'}
        </button>
      </div>
      {agentStatus && agentStatus.state !== 'running' && (
        <p className={agentStatus.state === 'error' ? 'error' : 'empty'}>{agentStatus.message}</p>
      )}
      {proposals.length > 0 && (
        <div className="cue-proposals">
          {proposals.map((p, i) => (
            <div className="beat-card cue-proposal" key={i}>
              <div className="take-head">
                <strong>{p.title}</strong>
                <span className="badge">{p.function}</span>
                <span className="badge">{p.mood}</span>
                <span className="badge">{p.arc}</span>
              </div>
              <p className="empty">
                {p.instrumentation} · {p.era} · {p.bpm} BPM · {p.keyscale} · {p.timesignature}/4
              </p>
              {p.note && <p className="cue-note">{p.note}</p>}
              <p className="empty">{p.caption}</p>
              <button type="button" onClick={() => useProposal(p)}>
                Use this cue
              </button>
            </div>
          ))}
        </div>
      )}

      <h4>Write the cue</h4>
      <div className="upload-form">
        <input
          type="text"
          placeholder="Name it (optional) — e.g. Act 1 underscore"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
        />
        {generator !== 'sonilo_video' && (
          <label>
            Length (s){' '}
            <input
              type="number"
              min={5}
              /* ACE-Step 1.5 will go far longer than MiniMax; its latent node
                 accepts up to 1000s. Anything beyond a few minutes is a long
                 wait for a cue, so this stops at ten. */
              max={isAce(generator) ? 600 : 360}
              value={duration}
              onChange={(e) => setDuration(Number(e.target.value))}
            />
          </label>
        )}
      </div>
      {isAce(generator) && (
        <div className="upload-form ace-params">
          <label>
            BPM{' '}
            <input
              type="number"
              min={10}
              max={300}
              placeholder="auto"
              value={bpm}
              onChange={(e) => setBpm(e.target.value)}
            />
          </label>
          <label>
            Key{' '}
            <Select
              value={keyscale}
              onValueChange={setKeyscale}
              placeholder="auto"
              items={[{ value: '', label: 'auto (from caption)' }, ...KEYSCALES.map((k) => ({ value: k, label: k }))]}
            />
          </label>
          <label>
            Time{' '}
            <Select
              value={timesig}
              onValueChange={setTimesig}
              placeholder="auto"
              items={[
                { value: '', label: 'auto' },
                ...['2', '3', '4', '6'].map((t) => ({ value: t, label: `${t}/4` }))
              ]}
            />
          </label>
          <label>
            Lyrics language{' '}
            <Select
              value={language}
              onValueChange={setLanguage}
              items={ACE_LANGUAGES.map((l) => ({ value: l, label: l }))}
            />
          </label>
          <label className="ace-ref-audio">
            Reference track{' '}
            <input
              type="file"
              accept="audio/*"
              onChange={(e) => setRefAudio(e.target.files?.[0] ?? null)}
            />
          </label>
          {refAudio && (
            <button type="button" className="danger" onClick={() => setRefAudio(null)}>
              Clear
            </button>
          )}
        </div>
      )}
      {isAce(generator) && refAudio && (
        <p className="empty">
          The cue will take its timbre from <strong>{refAudio.name}</strong>. With a reference supplied the
          LM planning pass is switched off — ComfyUI's own guidance, since the reference carries the
          character instead — so this also renders faster.
        </p>
      )}
      <textarea
        className="prompt-editor"
        rows={4}
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        placeholder="Describe the music: genre, instruments, tempo, key, mood. e.g. lo-fi hip-hop, 78 BPM, D flat major, warm drums, laid-back and dreamy"
      />
      {(generator === 'sonilo_text' || isAce(generator)) && (
        <>
          <textarea
            className="prompt-editor"
            rows={5}
            value={lyrics}
            onChange={(e) => setLyrics(e.target.value)}
            placeholder="Lyrics (optional). Use section tags: [Intro] [Verse] [Chorus] [Instrumental] [Outro]"
          />
          <p className="empty">
            <strong>Leave lyrics empty for an instrumental bed</strong> and you get exactly the length set above.
            Write lyrics and the model decides the length from them instead — so a short lyric gives a short track no
            matter what the number says. Generated in a single pass either way, which is what makes it consistent;
            two halves generated separately would be two different pieces.
          </p>
        </>
      )}

      <div className="upload-form">
        <button
          type="button"
          disabled={
          status?.state === 'running' ||
          !prompt.trim() ||
          (generator === 'sonilo_video' && (videoSource === 'clip' ? !clipId : !file))
        }
          onClick={handleGenerate}
        >
          {status?.state === 'running' ? 'Generating…' : 'Generate score'}
        </button>
        <label>
          Takes{' '}
          <input
            className="take-count"
            type="number"
            min={1}
            max={6}
            value={takeCount}
            onChange={(e) => setTakeCount(Math.min(6, Math.max(1, Number(e.target.value) || 1)))}
            title="Same brief, different seeds — the cheapest way to get real variation"
          />
        </label>
        <button type="button" onClick={loadRows}>
          Refresh
        </button>
      </div>
      {status && status.state !== 'running' && (
        <p className={status.state === 'error' ? 'error' : 'run-status-ok'}>{status.message}</p>
      )}

      <h4>Scores</h4>
      {rows.length === 0 && <p className="empty">Nothing generated yet for {movie.title}.</p>}
      {rows.map((r) => (
        <div className="beat-card" key={r.id}>
          <div className="take-head">
            <strong>{r.title ?? 'Untitled'}</strong>
            <span className="badge">{r.status}</span>
            <span className="badge">{r.generator === 'sonilo_video' ? 'to picture' : `${r.duration_seconds}s`}</span>
            {r.source_filename && <span className="badge">{r.source_filename}</span>}
            {r.status === 'complete' && (
              <button type="button" onClick={() => handleMoreTakes(r)}>
                3 more takes
              </button>
            )}
            <button type="button" className="danger" onClick={() => handleDelete(r)}>
              Delete
            </button>
          </div>
          <p className="empty">{r.prompt}</p>
          {r.error_message && <p className="error">{r.error_message}</p>}
          {r.audio_path && (
            <>
              <audio src={comfyViewUrl(r.audio_path)} controls preload="metadata" style={{ width: '100%' }} />
              <p className="empty">{r.audio_path}</p>
            </>
          )}
        </div>
      ))}
    </div>
  )
}
