import { useEffect, useRef, useState } from 'react'
import { ChevronLeft, ChevronRight } from 'lucide-react'

/**
 * Choose which frame of a clip an extension continues from.
 *
 * Extend anchors the tail of the source clip into the new one, so whatever is
 * in that hand-off frame is all the model knows. If a character walked out of
 * shot before the end, extending from the true last frame gives it no pixels of
 * them - and it invents a different person when they walk back in. Picking the
 * last frame where the cast is still present fixes that, at the cost of losing
 * the tail.
 *
 * The scrub is done by seeking a <video> rather than decoding frames, which
 * needs no extra library and shows the actual frame the flow will use.
 */
export function FramePicker({
  src,
  frames,
  fps = 24,
  minFrame = 0,
  value,
  onChange,
  onConfirm,
  onCancel,
  busy,
  confirmLabel = 'Extend from here',
  busyLabel = 'Extending…',
  onGrab
}: {
  src: string
  frames: number
  fps?: number
  /** Extend needs a run of source behind the chosen frame, so it cannot be 0. */
  minFrame?: number
  value: number
  onChange: (frame: number) => void
  onConfirm: () => void
  onCancel: () => void
  busy?: boolean
  confirmLabel?: string
  busyLabel?: string
  /** Given the displayed frame as a PNG. Absent hides the button. */
  onGrab?: (png: Blob, frame: number) => void | Promise<void>
}) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const [ready, setReady] = useState(false)

  // Seek on every change so the preview always shows the frame that will be
  // used. +0.5 lands mid-frame: seeking to an exact boundary can resolve to
  // either neighbour depending on the decoder.
  useEffect(() => {
    const v = videoRef.current
    if (!v || !ready) return
    const t = (value + 0.5) / fps
    if (Math.abs(v.currentTime - t) > 0.001) v.currentTime = t
  }, [value, fps, ready])

  async function grab() {
    const v = videoRef.current
    if (!v || !onGrab) return
    const c = document.createElement('canvas')
    c.width = v.videoWidth
    c.height = v.videoHeight
    const ctx = c.getContext('2d')
    if (!ctx) return
    ctx.drawImage(v, 0, 0)
    const png: Blob | null = await new Promise((res) => c.toBlob(res, 'image/png'))
    if (png) await onGrab(png, value)
  }

  const last = Math.max(minFrame, frames - 1)
  const clamp = (f: number) => Math.min(last, Math.max(minFrame, f))
  const seconds = value / fps

  return (
    <div className="frame-picker">
      <video
        ref={videoRef}
        src={src}
        preload="auto"
        muted
        playsInline
        /* Required for grabFrame: without it the canvas is tainted by the
           cross-origin video and toBlob throws. ComfyUI serves /view with
           permissive CORS headers, so this succeeds. */
        crossOrigin="anonymous"
        onLoadedData={() => setReady(true)}
      />

      <div className="frame-picker-scrub">
        <button
          type="button"
          className="frame-step"
          title="Back one frame"
          disabled={busy || value <= minFrame}
          onClick={() => onChange(clamp(value - 1))}
        >
          <ChevronLeft size={15} />
        </button>
        <input
          type="range"
          min={minFrame}
          max={last}
          step={1}
          value={value}
          disabled={busy}
          onChange={(e) => onChange(clamp(Number(e.target.value)))}
        />
        <button
          type="button"
          className="frame-step"
          title="Forward one frame"
          disabled={busy || value >= last}
          onClick={() => onChange(clamp(value + 1))}
        >
          <ChevronRight size={15} />
        </button>
      </div>

      <p className="empty frame-picker-readout">
        Frame {value} of {frames - 1} &middot; {seconds.toFixed(2)}s
        {value === last ? ' — the end of the clip' : ` — drops the last ${last - value} frame${last - value === 1 ? '' : 's'}`}
      </p>

      <div className="frame-picker-actions">
        <button type="button" disabled={busy} onClick={onConfirm}>
          {busy ? busyLabel : confirmLabel}
        </button>
        {onGrab && (
          <button type="button" className="frame-reset" disabled={busy} onClick={grab}>
            Save frame to references
          </button>
        )}
        <button type="button" className="danger" disabled={busy} onClick={onCancel}>
          Cancel
        </button>
        <button type="button" className="frame-reset" disabled={busy} onClick={() => onChange(last)}>
          Use last frame
        </button>
      </div>
    </div>
  )
}
