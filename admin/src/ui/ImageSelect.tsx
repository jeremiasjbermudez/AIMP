import { useState } from 'react'
import * as RadixSelect from '@radix-ui/react-select'
import { ChevronDown, ImageOff } from 'lucide-react'

// A picker that shows the picture, not just its name.
//
// A native <select> can only hold text, which is why the image pickers listed
// things like "MILO — qa_front v2" and left you to remember what that looked
// like. Radix renders real elements inside each option, so a thumbnail can sit
// beside the label. Groups are kept, since the sources come in meaningful
// families - characters, world, cleanups, edits.
//
// Thumbnails load lazily: a movie can have sixty-odd references and fetching
// them all when the menu opens would stall it.
export type ImageOption = {
  value: string
  label: string
  /** Absent for sources whose preview has to be fetched (storage-backed). */
  thumb?: string
  disabled?: boolean
}

export type ImageGroup = { label: string; items: ImageOption[] }

export function ImageSelect({
  value,
  onValueChange,
  groups,
  placeholder = 'Add an image…',
  disabled,
  resetAfterPick = false
}: {
  value: string
  onValueChange: (v: string) => void
  groups: ImageGroup[]
  placeholder?: string
  disabled?: boolean
  /** For "add to a list" use, where the trigger should not stay on a choice. */
  resetAfterPick?: boolean
}) {
  const total = groups.reduce((n, g) => n + g.items.length, 0)
  // Passing value={undefined} does NOT reset a Radix Select - it keeps its own
  // internal selection, so picking the SAME item twice fires no change event
  // and the second pick silently does nothing. Remounting on a bumped key is
  // what actually clears it.
  const [pickCount, setPickCount] = useState(0)
  return (
    <RadixSelect.Root
      key={resetAfterPick ? pickCount : undefined}
      value={resetAfterPick ? undefined : value || undefined}
      onValueChange={(v) => {
        onValueChange(v)
        if (resetAfterPick) setPickCount((n) => n + 1)
      }}
      disabled={disabled || total === 0}
    >
      <RadixSelect.Trigger className="ui-select image-select-trigger">
        <RadixSelect.Value placeholder={total === 0 ? 'Nothing to pick yet' : placeholder} />
        <RadixSelect.Icon className="ui-select-icon">
          <ChevronDown size={15} />
        </RadixSelect.Icon>
      </RadixSelect.Trigger>
      <RadixSelect.Portal>
        <RadixSelect.Content className="ui-select-content image-select-content" position="popper" sideOffset={6}>
          <RadixSelect.Viewport className="ui-select-viewport">
            {groups.map((g) =>
              g.items.length === 0 ? null : (
                <RadixSelect.Group key={g.label}>
                  <RadixSelect.Label className="image-select-group">
                    {g.label} <span className="empty">{g.items.length}</span>
                  </RadixSelect.Label>
                  {g.items.map((it) => (
                    <RadixSelect.Item
                      key={it.value}
                      value={it.value}
                      disabled={it.disabled}
                      className="ui-select-item image-select-item"
                    >
                      <span className="image-select-thumb">
                        {it.thumb ? (
                          <img src={it.thumb} alt="" loading="lazy" />
                        ) : (
                          <ImageOff size={14} />
                        )}
                      </span>
                      <RadixSelect.ItemText>{it.label}</RadixSelect.ItemText>
                    </RadixSelect.Item>
                  ))}
                </RadixSelect.Group>
              )
            )}
          </RadixSelect.Viewport>
        </RadixSelect.Content>
      </RadixSelect.Portal>
    </RadixSelect.Root>
  )
}
