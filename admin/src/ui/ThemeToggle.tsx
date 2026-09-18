import { useEffect, useState } from 'react'
import { Monitor, Moon, Sun } from 'lucide-react'

// Three states, not two. "system" is the default and follows the OS, which is
// what most people actually want; light and dark are explicit overrides that
// stick. Storing "system" as an absent attribute keeps the CSS simple - the
// media query in theme.css handles it.
export type ThemeChoice = 'light' | 'dark' | 'system'

const KEY = 'pipeline-admin-theme'

export function readThemeChoice(): ThemeChoice {
  try {
    const v = localStorage.getItem(KEY)
    if (v === 'light' || v === 'dark' || v === 'system') return v
  } catch {
    // Private windows and blocked site data throw rather than returning null.
  }
  return 'system'
}

export function applyThemeChoice(choice: ThemeChoice) {
  const root = document.documentElement
  if (choice === 'system') root.removeAttribute('data-theme')
  else root.setAttribute('data-theme', choice)
  try {
    localStorage.setItem(KEY, choice)
  } catch {
    // Not being able to remember the choice is not worth breaking the page for.
  }
}

const ORDER: ThemeChoice[] = ['system', 'light', 'dark']
const ICON = { system: Monitor, light: Sun, dark: Moon }
const LABEL = { system: 'Follow system', light: 'Light', dark: 'Dark' }

export function ThemeToggle() {
  const [choice, setChoice] = useState<ThemeChoice>(readThemeChoice)

  useEffect(() => {
    applyThemeChoice(choice)
  }, [choice])

  const Icon = ICON[choice]
  return (
    <button
      type="button"
      className="theme-toggle"
      title={`Theme: ${LABEL[choice]} — click to change`}
      aria-label={`Theme: ${LABEL[choice]}`}
      onClick={() => setChoice(ORDER[(ORDER.indexOf(choice) + 1) % ORDER.length])}
    >
      <Icon size={15} />
    </button>
  )
}
