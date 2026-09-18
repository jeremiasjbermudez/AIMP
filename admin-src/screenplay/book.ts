import { breakDown } from './api'
import { renumber, type ScreenplayTree, type SceneNode } from './model'

/**
 * Turning a book into a screenplay.
 *
 * A book cannot go through the breakdown in one piece - a novel is hundreds of
 * thousands of words and the model has a context window - so it is cut into
 * chapters and fed through a chapter at a time, appending as it goes. That also
 * makes it resumable and interruptible: a 40-chapter book is 40 calls, and
 * stopping after 12 leaves 12 chapters of real structure rather than nothing.
 */

/** How big a fallback chunk gets when a book has no chapter headings at all. */
const WORDS_PER_CHUNK = 2500

export type Chunk = { label: string; text: string }

/**
 * Cut a book into chapters.
 *
 * Tried in order of how reliable the signal is: an explicit chapter heading
 * beats a markdown heading, which beats a typographic scene break, which beats
 * counting words. Anything before the first heading - a title page, a dedication
 * - becomes its own leading chunk rather than being silently attached to
 * chapter one.
 */
export function splitBook(text: string): Chunk[] {
  const clean = text.replace(/\r\n/g, '\n').trim()
  if (!clean) return []

  const patterns: RegExp[] = [
    // CHAPTER ONE / Chapter 12 / CHAPTER XIV, on its own line.
    /^[ \t]*chapter\s+([0-9]+|[ivxlcdm]+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty)\b.*$/gim,
    // Markdown headings.
    /^[ \t]*#{1,3}[ \t]+.*$/gm,
    // A typographic break: * * * or ---
    /^[ \t]*(\*[ \t]*){3,}[ \t]*$|^[ \t]*-{3,}[ \t]*$/gm
  ]

  for (const re of patterns) {
    const marks = [...clean.matchAll(re)]
    // One match is not a structure - it is a stray line.
    if (marks.length < 2) continue
    const out: Chunk[] = []
    const first = marks[0].index ?? 0
    const front = clean.slice(0, first).trim()
    if (front) out.push({ label: 'Front matter', text: front })
    marks.forEach((m, i) => {
      const start = m.index ?? 0
      const end = i + 1 < marks.length ? (marks[i + 1].index ?? clean.length) : clean.length
      const body = clean.slice(start, end).trim()
      if (!body) return
      // A typographic break has no name - "* * *" as a label says nothing - so
      // those are numbered instead. Real headings keep their own words.
      const heading = m[0].trim()
      const named = /[a-z0-9]/i.test(heading)
      out.push({ label: named ? heading.slice(0, 60) : `Part ${i + 1}`, text: body })
    })
    return out
  }

  // No headings anywhere: fall back to paragraph batches, breaking only between
  // paragraphs so no sentence is ever cut in half.
  const paras = clean.split(/\n{2,}/)
  const out: Chunk[] = []
  let buf: string[] = []
  let words = 0
  const flush = () => {
    if (!buf.length) return
    out.push({ label: `Part ${out.length + 1}`, text: buf.join('\n\n') })
    buf = []
    words = 0
  }
  for (const p of paras) {
    const n = p.split(/\s+/).filter(Boolean).length
    if (words + n > WORDS_PER_CHUNK && buf.length) flush()
    buf.push(p)
    words += n
  }
  flush()
  return out
}

export type BookProgress = {
  index: number
  total: number
  label: string
  scenes: number
  error?: string
}

/**
 * Run a whole book through the breakdown, chapter by chapter.
 *
 * Everything lands in ONE act. Act structure in an adaptation is a creative
 * decision, not something that can be inferred from chapter boundaries, and
 * nothing downstream depends on it: scene numbers run continuously across acts,
 * and acts are only marked in the exported text by "END OF ACT n" lines. One
 * act now, split by hand later, is honest; one act per chapter would give a
 * thirty-chapter novel thirty acts.
 *
 * `onProgress` is called after every chapter so the UI can show the work and
 * `shouldStop` can end it early - what has been converted so far is kept.
 */
export async function bookToScreenplay(
  chunks: Chunk[],
  onProgress: (p: BookProgress) => void,
  shouldStop: () => boolean
): Promise<{ tree: ScreenplayTree; converted: number; failures: string[] }> {
  const scenes: SceneNode[] = []
  const failures: string[] = []
  let converted = 0

  for (let i = 0; i < chunks.length; i++) {
    if (shouldStop()) break
    const c = chunks[i]
    onProgress({ index: i, total: chunks.length, label: c.label, scenes: scenes.length })

    const res = await breakDown(c.text)
    if ('error' in res) {
      // One bad chapter does not end the book. It is named and skipped, and the
      // rest still converts - otherwise a single model hiccup forty chapters in
      // would throw away everything before it.
      failures.push(`${c.label}: ${res.error}`)
      continue
    }
    for (const act of res.tree.acts) for (const s of act.scenes) scenes.push(s)
    converted++
    onProgress({ index: i, total: chunks.length, label: c.label, scenes: scenes.length })
  }

  return { tree: renumber({ acts: [{ scenes }] }), converted, failures }
}
