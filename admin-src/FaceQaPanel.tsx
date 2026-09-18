import { useEffect, useState } from 'react'
import { insforge, comfyViewUrl, type Movie, type Character, type MinimaxClip } from './insforge'
import { triggerFlow, type RunStatus } from './flowise'
import { Select } from './ui/Select'
import { ClipThumbPicker } from './ui/ClipThumbPicker'
import { ImageSelect } from './ui/ImageSelect'
import { loadImageSources, toPickerGroups, type ImageSource } from './imageSources'
import { FaceFixControl } from './ui/FaceFixControl'
import { WorstFrames } from './ui/WorstFrames'
import { planFrom, GUIDE_FRAMES } from './faceqa'
import { saveFrameToProject, uploadImageToProject } from './frames'

// Manual face QA: pick a rendered clip, say who should be in it, get a number.
//
// Measurement only - nothing is edited. The point is to find drift and know how
// bad it is before deciding whether a repair pass is worth building.
type FrameScore = { frame: number; time: number; similarity: number; facePx: number }
type Result = {
  action?: string
  character?: string
  worst?: number
  worstAtSeconds?: number
  mean?: number
  best?: number
  sampled?: number
  framesScanned?: number
  framesRejected?: number
  referencesUsed?: { file: string; facePx: number }[]
  referencesSkipped?: { path: string; why: string }[]
  frames?: FrameScore[]
  reason?: string
  hint?: string
  // Set when the character is marked as never seen unmasked. Likeness is not
  // scored at all; the question becomes whether the mask stayed on.
  mode?: string
  verdict?: string
  note?: string
  uncoveredFrames?: number
  coveredFrames?: number
  firstUncoveredAt?: number | null
}

// Calibrated against this project's own reference sets: scoring every character
// against every other gave 0.05-0.30 between different people, so anything in
// that band is not the same face. A same-person render should clear 0.5.
const GOOD = 0.5
const SUSPECT = 0.35

function verdict(v: number): { label: string; cls: string } {
  if (v >= GOOD) return { label: 'holds up', cls: 'run-status-ok' }
  if (v >= SUSPECT) return { label: 'drifting', cls: 'badge' }
  return { label: 'does not match', cls: 'error' }
}

export function FaceQaPanel({ movie }: { movie: Movie }) {
  const [clips, setClips] = useState<MinimaxClip[]>([])
  const [characters, setCharacters] = useState<Character[]>([])
  const [clipId, setClipId] = useState('')
  const [characterId, setCharacterId] = useState('')
  const [everyNth, setEveryNth] = useState('6')
  const [maxFrames, setMaxFrames] = useState('24')
  const [status, setStatus] = useState<RunStatus | null>(null)
  const [result, setResult] = useState<Result | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [refImages, setRefImages] = useState<{ path: string; label: string }[]>([])
  const [retaking, setRetaking] = useState(false)
  const [retakeNote, setRetakeNote] = useState<string | null>(null)
  // The frame most recently pulled out of the clip, so the face fix has
  // something concrete to work on without another picker.
  const [savedFrame, setSavedFrame] = useState<string | null>(null)
  const [fixing, setFixing] = useState(false)
  // Standalone fix: any picture in the movie, not just one pulled out of a clip.
  const [sources, setSources] = useState<ImageSource[]>([])
  const [fixTarget, setFixTarget] = useState('')

  useEffect(() => {
    async function load() {
      const { data: c } = await insforge.database
        .from('minimax_clips')
        .select('*')
        .eq('movie_id', movie.id)
        .eq('status', 'complete')
        .order('created_at', { ascending: false })
      setClips(((c ?? []) as MinimaxClip[]).filter((x) => x.video_path))
      const { data: ch } = await insforge.database
        .from('characters')
        .select('*')
        .eq('movie_id', movie.id)
        .order('name', { ascending: true })
      setCharacters((ch ?? []) as Character[])
    }
    load()
    setResult(null)
    setClipId('')
  }, [movie.id])

  const clip = clips.find((c) => c.id === clipId)

  async function handleScore() {
    setStatus({ state: 'running', message: '' })
    setError(null)
    setResult(null)
    const r = await triggerFlow(import.meta.env.VITE_FACE_QA_ID, {
      clipId,
      characterId,
      everyNth: Number(everyNth) || 6,
      maxFrames: Number(maxFrames) || 24
    })
    if (r.state === 'error') {
      setError(r.message)
      setStatus(null)
      return
    }
    try {
      setResult(JSON.parse(r.message) as Result)
    } catch {
      setError(r.message)
    }
    setStatus(null)
  }

  // Load the reference images the score is measured against, so the gallery can
  // show them beside the failing frames.
  useEffect(() => {
    loadImageSources(movie.id).then(setSources)
    setFixTarget('')
  }, [movie.id])

  useEffect(() => {
    if (!characterId) {
      setRefImages([])
      return
    }
    insforge.database
      .from('character_images')
      .select('kind,version,image_path')
      .eq('character_id', characterId)
      .then(({ data }) => {
        // Mirrors the node's preference so "Compared against" shows what was
        // actually used: the purpose-built qa_* set when there is one, the
        // older kinds only as a fallback.
        const QA = ['qa_front', 'qa_threequarter_left', 'qa_threequarter_right', 'qa_low_angle']
        const LEGACY = ['closeup', 'portrait', 'uppertorso']
        const rows = ((data ?? []) as { kind: string; version: number; image_path: string | null }[])
          .filter((i) => i.image_path)
        const qa = rows.filter((i) => QA.includes(String(i.kind).toLowerCase()))
        const legacy = rows.filter((i) => LEGACY.includes(String(i.kind).toLowerCase()))
        const chosen = qa.length >= 2 ? qa : [...qa, ...legacy]
        setRefImages(
          chosen
            .slice(0, 6)
            .map((i) => ({ path: i.image_path as string, label: `${i.kind} v${i.version}` }))
        )
      })
  }, [characterId])

  /**
   * Retake from the anchor.
   *
   * Creates exactly the row the video tab's Extend creates - mode 'extend',
   * source_clip_id, guide_end_frame - so this is the same mechanism reached
   * from the evidence rather than from a slider.
   */
  /** Seek the clip and draw one frame out of it. */
  async function captureFrame(videoPath: string, time: number): Promise<Blob> {
    const v = document.createElement('video')
    v.crossOrigin = 'anonymous'
    v.src = comfyViewUrl(videoPath)
    await new Promise((res, rej) => {
      v.onloadeddata = res
      v.onerror = () => rej(new Error('The clip could not be read.'))
    })
    await new Promise((res) => {
      v.onseeked = res
      v.currentTime = Math.min(time, Math.max(0, (v.duration || 0) - 0.05))
    })
    const c = document.createElement('canvas')
    c.width = v.videoWidth
    c.height = v.videoHeight
    c.getContext('2d')?.drawImage(v, 0, 0)
    const blob = await new Promise<Blob | null>((res) => c.toBlob(res, 'image/png'))
    if (!blob) throw new Error('The frame could not be encoded.')
    return blob
  }

  /** Pull one frame out of the clip and file it as a project frame. */
  async function grabFrame(frame: number, time: number) {
    if (!clip?.video_path) return
    setRetakeNote(null)
    try {
      const blob = await captureFrame(clip.video_path, time)
      const saved = await saveFrameToProject(movie, blob, { clipId: clip.id, frame })
      if ('error' in saved) {
        setRetakeNote(saved.error)
        return
      }
      setSavedFrame(saved.image_path)
      setRetakeNote(`Frame ${frame} saved to ${saved.image_path}.`)
    } catch (e) {
      setRetakeNote(e instanceof Error ? e.message : String(e))
    }
  }

  async function fixFrame(frame: number, time: number): Promise<{ path?: string; error?: string }> {
    if (!clip?.video_path || !characterId) return { error: 'Pick a character first.' }
    try {
      const blob = await captureFrame(clip.video_path, time)
      // Uploaded, NOT filed as a project frame. The face fix needs the source on
      // disk to read, but nobody asked to keep it - and registering it in
      // movie_frames put every intermediate grab into the Frames group of every
      // image picker. Only the repainted result is worth offering, and that
      // arrives on its own as an image_edits row.
      const src = await uploadImageToProject(
        movie,
        blob,
        '_face_fix_src',
        `src_${frame}_${Date.now()}.png`
      )
      if ('error' in src) return { error: src.error }
      const r = await triggerFlow(import.meta.env.VITE_FACE_FIX_ID, {
        imagePath: src.image_path,
        characterId
      })
      if (r.state === 'error') return { error: r.message }
      const out = JSON.parse(r.message)
      if (out.action !== 'complete') return { error: out.reason ?? out.error ?? 'Face fix failed.' }
      return { path: out.imagePath }
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) }
    }
  }

  async function handleFixFace() {
    if (!savedFrame || !characterId) return
    setFixing(true)
    setRetakeNote('Repainting the face…')
    const r = await triggerFlow(import.meta.env.VITE_FACE_FIX_ID, {
      imagePath: savedFrame,
      characterId
    })
    setFixing(false)
    if (r.state === 'error') {
      setRetakeNote(`Face fix failed: ${r.message}`)
      return
    }
    try {
      const out = JSON.parse(r.message)
      if (out.action !== 'complete') throw new Error(out.reason ?? out.error ?? 'Face fix failed.')
      setSavedFrame(out.imagePath)
      setRetakeNote(
        `Face repainted to match ${out.character} — ${out.imagePath}. ` +
          'It is in the Edits group; use it as a first frame on Image to Video. ' +
          'If nothing changed, no face was detected, which is a no-op by design.'
      )
    } catch (e) {
      setRetakeNote(e instanceof Error ? e.message : String(e))
    }
  }

  async function handleRetake(anchorFrame: number) {
    if (!clip) return
    setRetaking(true)
    setError(null)
    setRetakeNote(null)
    const { data: inserted, error: insertError } = await insforge.database
      .from('minimax_clips')
      .insert([
        {
          movie_id: movie.id,
          beat_id: clip.beat_id,
          mode: 'extend',
          source_clip_id: clip.id,
          prompt: clip.prompt,
          width: clip.width,
          height: clip.height,
          length: clip.length,
          guide_end_frame: anchorFrame,
          status: 'queued'
        }
      ])
      .select()
    if (insertError) {
      setError(insertError.message)
      setRetaking(false)
      return
    }
    const created = ((inserted ?? []) as MinimaxClip[])[0]
    if (!created) {
      setError('The retake row was not created.')
      setRetaking(false)
      return
    }
    const r = await triggerFlow(import.meta.env.VITE_MINIMAX_EXTEND_ID, { clipId: created.id })
    setRetaking(false)
    setRetakeNote(
      r.state === 'error'
        ? `Retake failed to start: ${r.message}`
        : 'Retake queued — it renders on the server and appears on the Image to Video tab. ' +
          'Cut the original at the drift and join the retake there.'
    )
  }

  const running = status?.state === 'running'
  const blocked = !clipId ? 'a clip' : !characterId ? 'a character' : ''

  return (
    <div>
      <p>
        Scores a rendered clip against a character's reference images and reports how far the face has
        drifted. Nothing is changed here - this only measures, so you can see which clips need attention
        before deciding what to do about them.
      </p>

      <h4>Clip</h4>
      <ClipThumbPicker
        value={clipId}
        onValueChange={setClipId}
        clips={clips.map((c) => ({
          id: c.id,
          video_path: c.video_path,
          label: `${c.mode} · ${c.length} frames`,
          sub: new Date(c.created_at).toLocaleString()
        }))}
      />
      {clip?.video_path && (
        <video className="shot-preview" src={comfyViewUrl(clip.video_path)} controls preload="metadata" />
      )}

      <h4>Who should be in it</h4>
      <Select
        value={characterId}
        onValueChange={setCharacterId}
        placeholder={characters.length ? 'Pick a character' : 'No characters yet'}
        items={characters.map((c) => ({ value: c.id, label: c.name }))}
      />
      <p className="empty">
        Their reference images are the yardstick. Close-ups and portraits work best; a turnaround puts
        the face at about 50px, which is too small to identify and gets skipped.
      </p>

      <h4>Sampling</h4>
      <div className="upload-form">
        <label>
          Every Nth frame
          <input type="number" min={1} value={everyNth} onChange={(e) => setEveryNth(e.target.value)} />
        </label>
        <label>
          Max frames
          <input type="number" min={1} value={maxFrames} onChange={(e) => setMaxFrames(e.target.value)} />
        </label>
        <button type="button" disabled={running || !!blocked} onClick={handleScore}>
          {running ? 'Scoring…' : 'Score this clip'}
        </button>
      </div>
      {!running && blocked && <p className="empty">Scoring needs: {blocked}.</p>}
      {error && <p className="error">{error}</p>}

      <h4>Fix a face on any picture</h4>
      <p className="empty">
        The same repaint, without scoring anything first. Pick any picture in {movie.title} — a
        character render, a panorama, an edit, a saved frame — and repaint just the face to match a
        character. Everything outside the detected face keeps its original pixels.
      </p>
      <div className="upload-form">
        <ImageSelect
          value={fixTarget}
          groups={toPickerGroups(sources)}
          placeholder="Pick a picture…"
          onValueChange={setFixTarget}
        />
        {fixTarget && (
          <FaceFixControl
            movie={movie}
            imagePath={sources.find((x) => x.id === fixTarget)?.path ?? ''}
            onFixed={() => loadImageSources(movie.id).then(setSources)}
          />
        )}
      </div>
      {fixTarget && (
        <img
          className="edit-output"
          src={comfyViewUrl(sources.find((x) => x.id === fixTarget)?.path ?? '')}
          alt=""
        />
      )}

      {result && result.action === 'error' && (
        <>
          <h4>Result</h4>
          <p className="error">{result.reason}</p>
          {result.hint && <p className="empty">{result.hint}</p>}
        </>
      )}

      {result && result.action === 'complete' && result.mode === 'covered' && (
        <>
          <h4>Result</h4>
          <div className="beat-card">
            <p>
              <strong>{result.character}</strong>{' '}
              <span className={result.uncoveredFrames ? 'error' : 'run-status-ok'}>{result.verdict}</span>
            </p>
            <p className="empty">{result.note}</p>
            <p className="empty">
              This character is marked as never seen unmasked, so no likeness score is reported - behind
              a cowl there is nothing meaningful to compare against. Note this detects whether a face is
              present, not whose: in a shot with another character it will find theirs too.
            </p>
          </div>
        </>
      )}

      {result && result.action === 'complete' && result.mode !== 'covered' && typeof result.worst === 'number' && (
        <>
          <h4>Result</h4>
          <div className="beat-card">
            <p>
              <strong>{result.character}</strong>{' '}
              <span className={verdict(result.worst).cls}>{verdict(result.worst).label}</span>
            </p>
            <p>
              {/* The worst frame is the headline. An average over the clip hides a
                  short stretch of drift, which is exactly what to look for. */}
              Worst <strong>{result.worst.toFixed(3)}</strong> at {result.worstAtSeconds}s · mean{' '}
              {result.mean?.toFixed(3)} · best {result.best?.toFixed(3)}
            </p>
            <p className="empty">
              {result.sampled} frames scored of {result.framesScanned} scanned
              {result.framesRejected ? `, ${result.framesRejected} skipped (no face big enough)` : ''}.
              Above {GOOD} is a match; below {SUSPECT} is a different face.
            </p>
            {result.frames && result.frames.length > 0 && (
              <p className="empty">
                Per frame: {result.frames.map((f) => `${f.time}s ${f.similarity.toFixed(2)}`).join(' · ')}
              </p>
            )}
            {result.referencesUsed && result.referencesUsed.length > 0 && (
              <p className="empty">
                References used: {result.referencesUsed.map((r) => `${r.file} (${r.facePx}px)`).join(', ')}
              </p>
            )}
            {result.referencesSkipped && result.referencesSkipped.length > 0 && (
              <p className="empty">
                Skipped: {result.referencesSkipped.map((r) => `${r.path.split('/').pop()} — ${r.why}`).join('; ')}
              </p>
            )}
          </div>
          {/* The number is the alarm; this is the evidence. */}
          {clip?.video_path && result.frames && result.frames.length > 0 && (
            <WorstFrames
              videoPath={clip.video_path}
              frames={result.frames}
              good={GOOD}
              suspect={SUSPECT}
              references={refImages}
              canFix={!!characterId}
              onFixFrame={fixFrame}
            />
          )}

          {/* What can actually be done, worked out from where the clean frames
              are rather than left to judgement. */}
          {clip && result.frames && result.frames.length > 0 && (() => {
            const plan = planFrom(result.frames, GOOD)
            if (plan.kind === 'clean') {
              return (
                <>
                  <h4>What next</h4>
                  <p className="empty">
                    Every sampled frame clears {GOOD}. Nothing to do — if the gallery above looks
                    wrong anyway, the recogniser is being generous and the frames are the truth.
                  </p>
                </>
              )
            }
            // No anchor, for either reason: the action is the same - fix the
            // first frame and render again. The causes differ and the note says
            // so, but splitting the advice would be a distinction without a
            // difference at the point of doing something about it.
            if (plan.kind === 'reroll' || plan.kind === 'nomatch') {
              return (
                <>
                  <h4>What next</h4>
                  <p className="empty">
                    {plan.kind === 'reroll'
                      ? `The face is already drifting at ${plan.firstBadTime}s, before there are ${GUIDE_FRAMES} clean frames to hand off from.`
                      : `This clip never clears ${GOOD} at any sampled frame - best was ${plan.best.toFixed(3)}.`}{' '}
                    There is nowhere in it to continue from, so fix the first frame and render the
                    clip again from that.
                  </p>
                  {plan.kind === 'nomatch' && (
                    <p className="empty">
                      Check the frames above before spending a render: if the face is in hard
                      profile, small, or turned away, the recogniser cannot work with it and the
                      score means nothing. If it looks fine to you, it is more likely the wrong
                      character for this clip than a bad render.
                    </p>
                  )}
                  <div className="upload-form">
                    <button type="button" disabled={retaking} onClick={() => grabFrame(0, 0)}>
                      Save the first frame
                    </button>
                    <span className="empty">
                      Puts it in the project so you can relight or edit it, then use it as a first
                      frame on Image to Video.
                    </span>
                  </div>
                  {savedFrame && (
                    <div className="upload-form">
                      <button type="button" disabled={fixing} onClick={handleFixFace}>
                        {fixing ? 'Repainting…' : 'Fix the face on that frame'}
                      </button>
                      <span className="empty">
                        Repaints only the detected face to match {characters.find((x) => x.id === characterId)?.name ?? 'the character'} — everything outside the mask stays
                        the original pixels.
                      </span>
                    </div>
                  )}
                  {retakeNote && <p className="empty">{retakeNote}</p>}
                </>
              )
            }
            return (
              <>
                <h4>What next</h4>
                <p className="empty">
                  Holds until {plan.firstBadTime}s. The last frame with {GUIDE_FRAMES} clean frames
                  behind it is <strong>{plan.anchorFrame}</strong> ({plan.anchorTime}s) — a retake
                  continues from there, so it starts from a face that still matches.
                </p>
                <div className="upload-form">
                  <button type="button" disabled={retaking} onClick={() => handleRetake(plan.anchorFrame)}>
                    {retaking ? 'Queueing…' : `Retake from frame ${plan.anchorFrame}`}
                  </button>
                  <button
                    type="button"
                    disabled={retaking}
                    onClick={() => grabFrame(plan.anchorFrame, plan.anchorTime)}
                  >
                    Save the anchor frame
                  </button>
                </div>
                {savedFrame && (
                  <div className="upload-form">
                    <button type="button" disabled={fixing} onClick={handleFixFace}>
                      {fixing ? 'Repainting…' : 'Fix the face on that frame'}
                    </button>
                    <span className="empty">
                      Worth doing when the anchor is only marginally good, so the retake continues
                      from a correct face rather than a half-drifted one.
                    </span>
                  </div>
                )}
                {retakeNote && <p className="empty">{retakeNote}</p>}
              </>
            )
          })()}
        </>
      )}
    </div>
  )
}
