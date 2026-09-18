import { useEffect, useMemo, useRef, useState } from 'react'
import * as RadixSelect from '@radix-ui/react-select'
import { ChevronDown, Search, X } from 'lucide-react'

// Choosing a LoRA, in two shapes.
//
// `LoraNameSelect` is one searchable dropdown listing what ComfyUI actually has
// in models/loras. `LoraPicker` builds a stack of them on top of it. Characters
// take exactly one, with its own model and clip strengths, so they use the
// select directly rather than the stack.
//
// The list comes from ComfyUI rather than a hardcoded array, so a LoRA dropped
// into the folder appears without a code change - and one that is renamed or
// deleted stops being offered instead of failing at render time. ComfyUI serves
// /object_info with CORS enabled, so the browser can read it directly.

// `enabled` is optional so a stack saved before this existed still loads, and
// an absent value means on.
export type LoraChoice = { name: string; strength: number; enabled?: boolean }

/** The ones that actually go to the renderer. */
export function activeLoras(list: LoraChoice[]) {
  return list.filter((l) => l.enabled !== false).map(({ name, strength }) => ({ name, strength }))
}

const COMFY = import.meta.env.VITE_COMFY_URL

/** Group by top-level folder, so subfoldered LoRAs stay legible in a long list. */
function folderOf(name: string) {
  const at = name.replace(/\\/g, '/').indexOf('/')
  return at < 0 ? 'Loose files' : name.slice(0, at)
}

/** Filename without folders or the .safetensors suffix - the readable name. */
export function loraBaseName(name: string) {
  const clean = name.replace(/\\/g, '/')
  const at = clean.lastIndexOf('/')
  return (at < 0 ? clean : clean.slice(at + 1)).replace(/\.safetensors$/i, '')
}

/** Every LoRA ComfyUI can load, read once per mount. */
function useLoraNames() {
  const [names, setNames] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let cancelled = false
    async function load() {
      try {
        const res = await fetch(`${COMFY}/object_info/LoraLoader`)
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const info = await res.json()
        // ComfyUI describes an enum input as [[...options], {metadata}].
        const list = info?.LoraLoader?.input?.required?.lora_name?.[0]
        if (!Array.isArray(list)) throw new Error('unexpected /object_info shape')
        if (!cancelled) setNames(list.filter((n: unknown) => typeof n === 'string'))
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e))
      }
    }
    load()
    return () => {
      cancelled = true
    }
  }, [])
  return { names, error }
}

/**
 * One searchable dropdown of the available LoRAs.
 *
 * `exclude` hides names already chosen elsewhere. `resetAfterPick` leaves the
 * trigger on its placeholder rather than the last choice, which is what an
 * "add to a list" control wants.
 */
export function LoraNameSelect({
  value,
  onPick,
  exclude = [],
  disabled,
  placeholder = 'Choose a LoRA…',
  resetAfterPick = false,
  className
}: {
  value?: string
  onPick: (name: string) => void
  exclude?: string[]
  disabled?: boolean
  placeholder?: string
  resetAfterPick?: boolean
  className?: string
}) {
  const { names, error } = useLoraNames()
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState(false)
  const [pickCount, setPickCount] = useState(0)
  const searchRef = useRef<HTMLInputElement>(null)

  const groups = useMemo(() => {
    const hidden = new Set(exclude)
    // Every whitespace-separated word must appear somewhere in the full path,
    // so "ltx motion" finds "ltx-2.3-22b-ic-lora-motion-track-control" without
    // needing the words in order. Matched against the whole path, not just the
    // displayed name, so a folder like H3 is a usable search term too.
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean)
    const byFolder = new Map<string, string[]>()
    // A value set before this list loaded - or pointing at a file since removed
    // - still has to be selectable, or opening the menu would silently drop it.
    const pool = value && !names.includes(value) ? [value, ...names] : names
    for (const name of pool) {
      if (hidden.has(name)) continue
      const hay = name.toLowerCase()
      if (terms.length && !terms.every((t) => hay.includes(t))) continue
      const f = folderOf(name)
      if (!byFolder.has(f)) byFolder.set(f, [])
      byFolder.get(f)!.push(name)
    }
    return [...byFolder.entries()]
      .sort((a, b) => (a[0] === 'Loose files' ? -1 : b[0] === 'Loose files' ? 1 : a[0].localeCompare(b[0])))
      .map(([label, items]) => ({ label, items: items.sort((a, b) => loraBaseName(a).localeCompare(loraBaseName(b))) }))
  }, [names, exclude, query, value])

  // Radix Select puts focus on the list when it opens, so its own typeahead
  // can work. The search box wants those keys instead. Select has no
  // onOpenAutoFocus (that is Popover/Dialog), so focus is moved on the frame
  // after the content mounts.
  useEffect(() => {
    if (!open) return
    const id = requestAnimationFrame(() => searchRef.current?.focus())
    return () => cancelAnimationFrame(id)
  }, [open])

  const remaining = groups.reduce((n, g) => n + g.items.length, 0)

  if (error) {
    return <p className="error">Could not read the LoRA list from ComfyUI ({error}).</p>
  }

  return (
    <RadixSelect.Root
      key={resetAfterPick ? pickCount : undefined}
      value={resetAfterPick ? undefined : value || undefined}
      onValueChange={(v) => {
        onPick(v)
        if (resetAfterPick) setPickCount((n) => n + 1)
      }}
      disabled={disabled || names.length === 0}
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (next) setQuery('')
      }}
    >
      <RadixSelect.Trigger className={'ui-select' + (className ? ' ' + className : '')}>
        <RadixSelect.Value placeholder={names.length === 0 ? 'Loading LoRAs…' : placeholder} />
        <RadixSelect.Icon className="ui-select-icon">
          <ChevronDown size={15} />
        </RadixSelect.Icon>
      </RadixSelect.Trigger>
      <RadixSelect.Portal>
        <RadixSelect.Content className="ui-select-content lora-select-content" position="popper" sideOffset={6}>
          <div className="lora-search">
            <Search size={14} />
            <input
              ref={searchRef}
              value={query}
              placeholder="Search LoRAs…"
              onChange={(e) => setQuery(e.target.value)}
              // Without this, Radix reads each keystroke as typeahead and jumps
              // the highlight around instead of letting you type.
              onKeyDown={(e) => e.stopPropagation()}
            />
            {query && (
              <button type="button" className="ref-remove" title="Clear" onClick={() => setQuery('')}>
                <X size={13} />
              </button>
            )}
          </div>
          {remaining === 0 && (
            <p className="empty lora-no-match">{query ? `Nothing matches "${query}".` : 'Nothing to pick.'}</p>
          )}
          <RadixSelect.Viewport className="ui-select-viewport">
            {groups.map((g) => (
              <RadixSelect.Group key={g.label}>
                <RadixSelect.Label className="image-select-group">
                  {g.label} <span className="empty">{g.items.length}</span>
                </RadixSelect.Label>
                {g.items.map((name) => (
                  <RadixSelect.Item key={name} value={name} className="ui-select-item">
                    <RadixSelect.ItemText>{loraBaseName(name)}</RadixSelect.ItemText>
                  </RadixSelect.Item>
                ))}
              </RadixSelect.Group>
            ))}
          </RadixSelect.Viewport>
        </RadixSelect.Content>
      </RadixSelect.Portal>
    </RadixSelect.Root>
  )
}

/**
 * A stack of LoRAs, each with its own strength.
 *
 * Order is preserved and shown, because LoraLoaders are chained: the second
 * LoRA sees a model the first has already modified, so the same two at the same
 * strengths in the other order are a different image.
 */
export function LoraPicker({
  value,
  onChange,
  disabled
}: {
  value: LoraChoice[]
  onChange: (next: LoraChoice[]) => void
  disabled?: boolean
}) {
  function add(name: string) {
    // 1.0 is the LoRA's own trained strength - the neutral starting point to
    // tune from, rather than a number chosen for one particular LoRA.
    onChange([...value, { name, strength: 1 }])
  }

  function setEnabled(i: number, on: boolean) {
    const next = value.slice()
    next[i] = { ...next[i], enabled: on }
    onChange(next)
  }

  function setStrength(i: number, raw: string) {
    const n = Number(raw)
    const next = value.slice()
    next[i] = { ...next[i], strength: Number.isFinite(n) ? Math.max(0, Math.min(2, n)) : 0 }
    onChange(next)
  }

  return (
    <div className="lora-picker">
      {value.map((l, i) => (
        <div className={'lora-row' + (l.enabled === false ? ' is-off' : '')} key={l.name}>
          {/* Untick to leave it out of the next render without losing the
              strength you tuned; the X removes it from the list entirely. */}
          <input
            type="checkbox"
            className="lora-toggle"
            title={l.enabled === false ? 'Use this LoRA' : 'Skip this LoRA'}
            disabled={disabled}
            checked={l.enabled !== false}
            onChange={(e) => setEnabled(i, e.target.checked)}
          />
          <span className="lora-order">
            {l.enabled === false ? '–' : value.slice(0, i + 1).filter((x) => x.enabled !== false).length}
          </span>
          <span className="lora-name" title={l.name}>
            {loraBaseName(l.name)}
          </span>
          <input
            className="lora-strength"
            type="number"
            step="0.05"
            min={0}
            max={2}
            disabled={disabled || l.enabled === false}
            value={l.strength}
            onChange={(e) => setStrength(i, e.target.value)}
          />
          <button
            type="button"
            className="ref-remove"
            title={`Remove ${loraBaseName(l.name)}`}
            disabled={disabled}
            onClick={() => onChange(value.filter((_, k) => k !== i))}
          >
            <X size={14} />
          </button>
        </div>
      ))}

      <LoraNameSelect
        onPick={add}
        exclude={value.map((v) => v.name)}
        disabled={disabled}
        resetAfterPick
        placeholder={value.length ? 'Add another LoRA…' : 'Add a LoRA…'}
      />
    </div>
  )
}
