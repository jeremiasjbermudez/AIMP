/**
 * Which language model everything uses, chosen from the header.
 *
 * Story work - parsing a script into beats, drafting, naming a colour - runs on
 * a language model. That used to be set once at install time and baked into
 * every flow, so changing it meant re-installing every module that calls one.
 *
 * Now the choice is a row in app_settings, every flow reads it as it calls, and
 * this writes it. Switching model takes effect on the next run: no re-install,
 * no restart.
 *
 * Profiles rather than one set of fields, because the useful case is having a
 * local model and a hosted one and moving between them, not retyping a URL.
 */
import { useEffect, useState } from 'react'
import { insforge } from '../insforge'
import { Select } from './Select'

export type LlmProfile = {
  id: string
  label: string
  /** 'ollama' speaks Ollama's own API; 'openai' is anything OpenAI-compatible. */
  provider: 'ollama' | 'openai'
  url: string
  model: string
  /** Empty for a local server. */
  apiKey?: string
}

type LlmSettings = { selected: string; profiles: LlmProfile[] }

/**
 * What the add form offers. 'claude' is not a provider of its own: it is the
 * Claude Code CLI behind bridge/claude-bridge.js, which speaks the OpenAI API,
 * so it is saved as an 'openai' profile and every flow's shim works unchanged.
 */
type Kind = 'ollama' | 'openai' | 'claude'
type Draft = Omit<LlmProfile, 'id' | 'provider'> & { kind: Kind }

// 127.0.0.1, not localhost: the bridge listens on IPv4 loopback only, and
// Node can resolve localhost to ::1 first.
const CLAUDE_BRIDGE_URL = 'http://127.0.0.1:11435'
const CLAUDE_MODELS = [
  { value: 'sonnet', label: 'Sonnet' },
  { value: 'opus', label: 'Opus' },
  { value: 'haiku', label: 'Haiku' },
  { value: 'fable', label: 'Fable' }
]

const EMPTY: LlmSettings = { selected: '', profiles: [] }

/** A new profile's starting point, per kind. */
function blank(kind: Kind): Draft {
  if (kind === 'claude') return { kind, label: '', url: CLAUDE_BRIDGE_URL, model: 'sonnet', apiKey: '' }
  return kind === 'ollama'
    ? { kind, label: '', url: 'http://localhost:11434', model: '', apiKey: '' }
    : { kind, label: '', url: 'https://api.openai.com', model: '', apiKey: '' }
}

export function ModelPicker() {
  const [settings, setSettings] = useState<LlmSettings>(EMPTY)
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState<Draft>(blank('claude'))
  const [note, setNote] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let live = true
    insforge.database
      .from('app_settings')
      .select('value')
      .eq('key', 'llm')
      .limit(1)
      .then(({ data }) => {
        if (!live) return
        const value = ((data ?? []) as { value: LlmSettings }[])[0]?.value
        if (value?.profiles) setSettings({ selected: value.selected ?? '', profiles: value.profiles })
      })
    return () => {
      live = false
    }
  }, [])

  async function save(next: LlmSettings) {
    setBusy(true)
    setNote(null)
    // Upsert by hand: one row, known key, and the table is tiny.
    const { data } = await insforge.database.from('app_settings').select('key').eq('key', 'llm').limit(1)
    const exists = ((data ?? []) as unknown[]).length > 0
    const { error } = exists
      ? await insforge.database.from('app_settings').update({ value: next }).eq('key', 'llm')
      : await insforge.database.from('app_settings').insert([{ key: 'llm', value: next }])
    setBusy(false)
    if (error) {
      setNote(error.message)
      return false
    }
    setSettings(next)
    return true
  }

  async function choose(id: string) {
    if (id === '__add__') {
      setOpen(true)
      return
    }
    const ok = await save({ ...settings, selected: id })
    if (ok) {
      const chosen = settings.profiles.find((p) => p.id === id)
      setNote(`Everything now uses ${chosen?.label ?? 'that model'}.`)
    }
  }

  async function add(e: React.FormEvent) {
    e.preventDefault()
    if (!draft.url.trim() || !draft.model.trim()) {
      setNote('A URL and a model name are needed.')
      return
    }
    const { kind, ...fields } = draft
    const provider = kind === 'ollama' ? 'ollama' : 'openai'
    const fallbackLabel =
      kind === 'claude'
        ? `Claude ${CLAUDE_MODELS.find((m) => m.value === draft.model)?.label ?? draft.model} (CLI)`
        : `${draft.model} (${provider})`
    const profile: LlmProfile = {
      ...fields,
      provider,
      id: `${kind}-${Date.now()}`,
      label: draft.label.trim() || fallbackLabel,
      url: draft.url.trim().replace(/\/$/, ''),
      model: draft.model.trim()
    }
    // A model added by hand is the one you want to use, so it is selected too.
    const ok = await save({ selected: profile.id, profiles: [...settings.profiles, profile] })
    if (ok) {
      setOpen(false)
      setDraft(blank('claude'))
      setNote(`Added ${profile.label}, and everything now uses it.`)
    }
  }

  async function remove(id: string) {
    const left = settings.profiles.filter((p) => p.id !== id)
    await save({ selected: settings.selected === id ? (left[0]?.id ?? '') : settings.selected, profiles: left })
  }

  const items = [
    ...settings.profiles.map((p) => ({ value: p.id, label: p.label })),
    { value: '__add__', label: '+ Add a model…' }
  ]

  return (
    <div className="model-picker">
      <Select
        value={settings.selected}
        onValueChange={choose}
        items={items}
        placeholder={settings.profiles.length ? 'Choose a model' : 'Model: as installed'}
      />
      {settings.selected && !open && (
        <button
          type="button"
          className="model-picker-remove"
          title="Forget this model"
          disabled={busy}
          onClick={() => remove(settings.selected)}
        >
          ×
        </button>
      )}

      {open && (
        <form className="model-picker-form" onSubmit={add}>
          <p className="empty">
            Every flow that calls a language model uses this, from the next run. Nothing needs
            re-installing.
          </p>
          <label className="empty">
            Kind
            <Select
              value={draft.kind}
              onValueChange={(v) => setDraft(blank(v === 'openai' || v === 'ollama' ? v : 'claude'))}
              items={[
                { value: 'claude', label: 'Claude Code (CLI)' },
                { value: 'ollama', label: 'Ollama (local)' },
                { value: 'openai', label: 'OpenAI-compatible API' }
              ]}
            />
          </label>
          <label className="empty">
            Name
            <input
              type="text"
              value={draft.label}
              placeholder="what to call it here"
              onChange={(e) => setDraft({ ...draft, label: e.target.value })}
            />
          </label>
          <label className="empty">
            URL
            <input
              type="text"
              value={draft.url}
              size={28}
              onChange={(e) => setDraft({ ...draft, url: e.target.value })}
            />
          </label>
          <label className="empty">
            Model
            {draft.kind === 'claude' ? (
              <Select
                value={draft.model}
                onValueChange={(v) => setDraft({ ...draft, model: v })}
                items={CLAUDE_MODELS}
              />
            ) : (
              <input
                type="text"
                value={draft.model}
                placeholder={draft.kind === 'ollama' ? 'e.g. the name ollama list shows' : 'the provider’s model name'}
                onChange={(e) => setDraft({ ...draft, model: e.target.value })}
              />
            )}
          </label>
          {draft.kind === 'claude' && (
            <p className="empty">
              Runs the Claude Code CLI on this machine through bridge/claude-bridge.js, signed in as
              whoever the CLI is signed in as. start-all starts the bridge; by hand:
              node bridge/claude-bridge.js
            </p>
          )}
          {draft.kind === 'openai' && (
            <label className="empty">
              API key
              <input
                type="password"
                value={draft.apiKey ?? ''}
                onChange={(e) => setDraft({ ...draft, apiKey: e.target.value })}
              />
            </label>
          )}
          <button type="submit" className="primary" disabled={busy}>
            {busy ? 'Saving…' : 'Add and use it'}
          </button>
          <button type="button" disabled={busy} onClick={() => setOpen(false)}>
            Cancel
          </button>
          {draft.kind === 'openai' && (
            <p className="empty">
              The key is stored in this project’s database, readable by anyone signed in to this
              app. Fine on a machine only you reach; think twice anywhere else.
            </p>
          )}
        </form>
      )}
      {note && <span className="empty">{note}</span>}
    </div>
  )
}
