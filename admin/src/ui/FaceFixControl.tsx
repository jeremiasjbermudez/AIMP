/**
 * "Fix face" on a result card.
 *
 * The same repaint Face QA offers, reachable without scoring anything. It was
 * originally only available at the end of a four-step chain - pick a clip,
 * pick a character, score, wait, save a frame - which made a generally useful
 * operation impossible to find.
 *
 * Needs a character, because the whole point is matching a specific person's
 * references; that is the one thing Face QA supplies for free and this has to
 * ask for.
 */
import { useEffect, useState } from 'react'
import { insforge, type Movie, type Character } from '../insforge'
import { triggerFlow } from '../flowise'
import { Select } from './Select'
import { NotInstalled } from './NotInstalled'
import { hasFlow } from '../modules'

export function FaceFixControl({
  movie,
  imagePath,
  onFixed
}: {
  movie: Movie
  imagePath: string
  onFixed?: (path: string) => void
}) {
  const [open, setOpen] = useState(false)
  const [characters, setCharacters] = useState<Character[]>([])
  const [characterId, setCharacterId] = useState('')
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    // On open, not on mount: this renders once per card.
    if (!open || characters.length) return
    insforge.database
      .from('characters')
      .select('*')
      .eq('movie_id', movie.id)
      .order('name', { ascending: true })
      .then(({ data }) => setCharacters((data ?? []) as Character[]))
  }, [open, movie.id, characters.length])

  async function run() {
    if (!characterId) return
    setBusy(true)
    setError(null)
    setNote(null)
    const r = await triggerFlow(import.meta.env.VITE_FACE_FIX_ID, { imagePath, characterId })
    setBusy(false)
    if (r.state === 'error') {
      setError(r.message)
      return
    }
    try {
      const out = JSON.parse(r.message)
      if (out.action !== 'complete') throw new Error(out.reason ?? out.error ?? 'Face fix failed.')
      setNote(
        `Repainted to match ${out.character}. It is in the Face fixes group of the image pickers. ` +
          'If nothing looks different, no face was detected — that is a no-op by design, not a failure.'
      )
      onFixed?.(out.imagePath)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  // This control belongs to the faceqa module, which may not be installed:
  // it appears on cards owned by other modules. Without its flow it says so
  // rather than offering a button that cannot work.
  if (!hasFlow(import.meta.env.VITE_FACE_FIX_ID)) {
    return <NotInstalled module="faceqa" feature="Fix face" inline />
  }

  if (!open) {
    return (
      <button
        type="button"
        className="grade-toggle"
        onClick={() => setOpen(true)}
        title="Repaint just the face to match a character"
      >
        Fix face
      </button>
    )
  }

  return (
    <div className="grade-inline">
      <p className="empty">
        Repaints only the detected face to match the character's close-up and portrait references.
        Everything outside the mask stays the original pixels.
      </p>
      <div className="grade-inline-row">
        <Select
          value={characterId}
          onValueChange={setCharacterId}
          placeholder={characters.length ? 'Which character?' : 'No characters yet'}
          items={characters.map((c) => ({ value: c.id, label: c.name }))}
        />
        <button type="button" disabled={!characterId || busy} onClick={run}>
          {busy ? 'Repainting…' : 'Fix face'}
        </button>
        <button
          type="button"
          onClick={() => {
            setOpen(false)
            setNote(null)
            setError(null)
          }}
        >
          Close
        </button>
      </div>
      {note && <p className="empty">{note}</p>}
      {error && <p className="error">{error}</p>}
    </div>
  )
}
