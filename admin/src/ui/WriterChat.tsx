import { useEffect, useRef, useState } from 'react'
import { triggerFlow } from '../flowise'

// A chat that produces a document.
//
// Shared by the screenplay writer and the character bible writer: both are a
// conversation whose real output is a block of text the writer then does
// something with, rather than an answer to read and discard. The difference
// between them is only the flow it talks to and what the finished text is for,
// so both are props.
export type ChatTurn = { role: 'user' | 'assistant'; content: string; doc?: string }

export function WriterChat({
  flowId,
  payload,
  placeholder,
  starters,
  emptyHint,
  roleLabel,
  docLabel,
  onUseDoc,
  extractDoc
}: {
  flowId: string
  /** Extra fields sent alongside `messages` - a movieId, say. */
  payload?: Record<string, unknown>
  placeholder: string
  starters?: string[]
  emptyHint: string
  roleLabel: string
  /** Label for the button that hands the produced text onward. */
  docLabel: string
  onUseDoc: (doc: string) => void
  /** Pulls the usable document out of a reply payload; '' when there is none. */
  extractDoc: (payload: Record<string, unknown>, reply: string) => string
}) {
  const [chat, setChat] = useState<ChatTurn[]>([])
  const [ask, setAsk] = useState('')
  const [thinking, setThinking] = useState(false)
  const [copied, setCopied] = useState<number | null>(null)
  const endRef = useRef<HTMLDivElement | null>(null)

  // Only follow the conversation down while a reply is arriving. Scrolling on
  // every render would yank the page while the writer is reading an earlier
  // draft, which is the whole point of a chat that emits long documents.
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
  }, [chat.length, thinking])

  async function send(text: string) {
    const trimmed = text.trim()
    if (!trimmed || thinking) return
    setAsk('')
    const next: ChatTurn[] = [...chat, { role: 'user', content: trimmed }]
    setChat(next)
    setThinking(true)
    const r = await triggerFlow(flowId, {
      ...(payload ?? {}),
      messages: next.map((t) => ({ role: t.role, content: t.content }))
    })
    setThinking(false)
    if (r.state === 'error') {
      setChat([...next, { role: 'assistant', content: r.message }])
      return
    }
    try {
      const parsed = JSON.parse(r.message) as Record<string, unknown>
      const reply = String(parsed.error ?? parsed.reply ?? '(no reply)')
      setChat([...next, { role: 'assistant', content: reply, doc: extractDoc(parsed, reply) }])
    } catch {
      // A flow that returned plain text rather than JSON is still worth showing.
      setChat([...next, { role: 'assistant', content: r.message }])
    }
  }

  async function copy(text: string, i: number) {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(i)
      window.setTimeout(() => setCopied(null), 1500)
    } catch {
      // Clipboard access can be refused; the text is on screen to select by hand.
    }
  }

  return (
    <div className="writer-chat-wrap">
      <div className="resolve-chat writer-chat">
        {chat.length === 0 && <p className="empty">{emptyHint}</p>}
        {chat.map((t, i) => (
          <div key={i} className={t.role === 'user' ? 'chat-turn chat-user' : 'chat-turn chat-assistant'}>
            <div className="chat-role">{t.role === 'user' ? 'You' : roleLabel}</div>
            <div className={t.doc ? 'chat-body chat-doc' : 'chat-body'}>{t.content}</div>
            {t.doc && (
              <div className="chat-actions">
                <button type="button" onClick={() => onUseDoc(t.doc as string)}>
                  {docLabel}
                </button>
                <button type="button" onClick={() => copy(t.doc as string, i)}>
                  {copied === i ? 'Copied' : 'Copy'}
                </button>
              </div>
            )}
          </div>
        ))}
        {thinking && <p className="empty">Writing… this takes a minute or two.</p>}
        <div ref={endRef} />
      </div>

      {chat.length === 0 && starters && starters.length > 0 && (
        <div className="chat-starters">
          {starters.map((s) => (
            <button key={s} type="button" disabled={thinking} onClick={() => send(s)}>
              {s}
            </button>
          ))}
        </div>
      )}

      <div className="upload-form">
        <input
          type="text"
          className="chat-input"
          value={ask}
          placeholder={placeholder}
          onChange={(e) => setAsk(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') send(ask)
          }}
        />
        <button type="button" disabled={thinking || !ask.trim()} onClick={() => send(ask)}>
          {thinking ? 'Writing…' : 'Send'}
        </button>
        {chat.length > 0 && (
          <button type="button" disabled={thinking} onClick={() => setChat([])}>
            Clear
          </button>
        )}
      </div>
    </div>
  )
}
