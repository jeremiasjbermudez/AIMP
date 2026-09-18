/**
 * Picking a rendered clip by looking at it.
 *
 * A dropdown of "9/9/2026, 1:20:01 PM - i2v_first, 124 frames" is unusable once
 * a project has more than a handful: every row reads the same, so you pick by
 * memory of when you rendered something. A poster frame is what you actually
 * recognise.
 *
 * The poster is the video element itself with `preload="metadata"`, seeked a
 * little way in. Frame zero is often a fade or a near-black opening, so it makes
 * a poor thumbnail; a fraction of a second in is representative. No canvas, no
 * data URLs, no extra fetches - the browser already has the header it needs.
 */
import { useEffect, useRef } from 'react'
import { comfyViewUrl } from '../insforge'

export type ClipChoice = {
  id: string
  label: string
  sub?: string
  video_path: string | null
}

/** How far in to seek for the poster frame. */
const POSTER_AT = 0.4

function Poster({ src }: { src: string }) {
  const ref = useRef<HTMLVideoElement>(null)
  useEffect(() => {
    const v = ref.current
    if (!v) return
    const onMeta = () => {
      // Guard against a clip shorter than the seek point.
      try {
        v.currentTime = Math.min(POSTER_AT, Math.max(0, (v.duration || 1) - 0.05))
      } catch {
        /* Seeking can throw before the browser has enough of the file. */
      }
    }
    v.addEventListener('loadedmetadata', onMeta)
    return () => v.removeEventListener('loadedmetadata', onMeta)
  }, [src])
  return <video ref={ref} className="clip-thumb" src={src} preload="metadata" muted playsInline />
}

export function ClipThumbPicker({
  clips,
  value,
  onValueChange,
  empty = 'No finished clips yet.'
}: {
  clips: ClipChoice[]
  value: string
  onValueChange: (id: string) => void
  empty?: string
}) {
  if (clips.length === 0) return <p className="empty">{empty}</p>
  return (
    <div className="clip-thumb-grid">
      {clips.map((c) => (
        <button
          type="button"
          key={c.id}
          className={'clip-thumb-card' + (value === c.id ? ' picked' : '')}
          onClick={() => onValueChange(c.id)}
          title={c.label}
        >
          {c.video_path ? (
            <Poster src={comfyViewUrl(c.video_path, c.id)} />
          ) : (
            <span className="clip-thumb clip-thumb-blank" />
          )}
          <span className="clip-thumb-label">{c.label}</span>
          {c.sub && <span className="clip-thumb-sub">{c.sub}</span>}
        </button>
      ))}
    </div>
  )
}
