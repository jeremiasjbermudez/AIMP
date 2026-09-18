import { useEffect, useState } from 'react'
import { X } from 'lucide-react'

// Full-size preview for every image in the app, mounted once.
//
// Done by delegation rather than by wiring a handler into each panel: there are
// a dozen images across seven panels and more arrive with every feature, so
// per-panel wiring would be out of date the moment it was written.
//
// Images inside a button, link or label are skipped. Those already do something
// when clicked - the Ref to Video thumbnails toggle selection - and stealing
// that click to open a preview would break picking. Those panels carry their own
// expand affordance instead.
type Shot = { src: string; label: string }

function eligible(el: HTMLElement | null): HTMLImageElement | null {
  if (!el || el.tagName !== 'IMG') return null
  const img = el as HTMLImageElement
  if (img.closest('button, a, label')) return null
  if (img.closest('.lightbox')) return null
  // Icons and tiny decorations are not worth a full-screen view.
  if (img.naturalWidth && img.naturalWidth < 80) return null
  return img
}

export function ImagePreview() {
  const [shot, setShot] = useState<Shot | null>(null)

  useEffect(() => {
    function onClick(e: MouseEvent) {
      const img = eligible(e.target as HTMLElement)
      if (!img) return
      e.preventDefault()
      setShot({ src: img.currentSrc || img.src, label: img.alt || 'image' })
    }
    // Capture phase, so a container that stops propagation cannot swallow it.
    document.addEventListener('click', onClick, true)
    return () => document.removeEventListener('click', onClick, true)
  }, [])

  useEffect(() => {
    if (!shot) return
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setShot(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [shot])

  if (!shot) return null

  return (
    <div className="image-preview" onClick={() => setShot(null)}>
      <div className="image-preview-inner" onClick={(e) => e.stopPropagation()}>
        <img src={shot.src} alt={shot.label} />
        <div className="image-preview-bar">
          <span title={shot.label}>{shot.label}</span>
          <a href={shot.src} target="_blank" rel="noreferrer">
            Open original
          </a>
          <button type="button" onClick={() => setShot(null)} aria-label="Close">
            <X size={15} />
          </button>
        </div>
      </div>
    </div>
  )
}
