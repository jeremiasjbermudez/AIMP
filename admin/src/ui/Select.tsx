import * as RadixSelect from '@radix-ui/react-select'
import { Check, ChevronDown } from 'lucide-react'

// A themed replacement for <select>.
//
// Native selects on Windows render their popup in OS chrome, which ignores the
// dark theme entirely and is the single most dated-looking part of the UI. This
// keeps the same shape as the native element it replaces - a value, a change
// handler, and a list of options - so call sites change by a couple of lines
// rather than being restructured.
export type SelectItem = { value: string; label: string; disabled?: boolean }

export function Select({
  value,
  onValueChange,
  items,
  placeholder = 'Select…',
  disabled,
  className
}: {
  value: string
  onValueChange: (v: string) => void
  items: SelectItem[]
  placeholder?: string
  disabled?: boolean
  className?: string
}) {
  return (
    <RadixSelect.Root value={value || undefined} onValueChange={onValueChange} disabled={disabled}>
      <RadixSelect.Trigger className={'ui-select' + (className ? ' ' + className : '')}>
        <RadixSelect.Value placeholder={placeholder} />
        <RadixSelect.Icon className="ui-select-icon">
          <ChevronDown size={15} />
        </RadixSelect.Icon>
      </RadixSelect.Trigger>
      <RadixSelect.Portal>
        <RadixSelect.Content className="ui-select-content" position="popper" sideOffset={6}>
          <RadixSelect.Viewport className="ui-select-viewport">
            {items.map((it) => (
              <RadixSelect.Item key={it.value} value={it.value} disabled={it.disabled} className="ui-select-item">
                <RadixSelect.ItemText>{it.label}</RadixSelect.ItemText>
                <RadixSelect.ItemIndicator className="ui-select-check">
                  <Check size={14} />
                </RadixSelect.ItemIndicator>
              </RadixSelect.Item>
            ))}
          </RadixSelect.Viewport>
        </RadixSelect.Content>
      </RadixSelect.Portal>
    </RadixSelect.Root>
  )
}
