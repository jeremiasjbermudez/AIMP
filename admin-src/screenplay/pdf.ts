import * as pdfjs from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl

/**
 * Read a screenplay PDF back as text, keeping its layout.
 *
 * A PDF has no lines and no paragraphs - only glyphs at coordinates - so the
 * naive `blob.text()` returns binary, and even a plain extraction returns one
 * unbroken run of words. That matters more for a screenplay than for prose,
 * because a screenplay says what a line IS by where it sits: a scene heading is
 * flush left, a character cue is indented about 3.7 inches, dialogue about 2.5.
 * Throw the indentation away and a cue is indistinguishable from action, which
 * is exactly the structure the breakdown needs.
 *
 * So: group the glyphs into lines by their baseline, sort each line by x, and
 * re-indent from the leftmost column on the page.
 */
export async function pdfToText(data: ArrayBuffer): Promise<string> {
  const doc = await pdfjs.getDocument({ data }).promise
  const pages: string[] = []

  for (let n = 1; n <= doc.numPages; n++) {
    const page = await doc.getPage(n)
    const content = await page.getTextContent()

    type Piece = { x: number; y: number; w: number; s: string }
    const pieces: Piece[] = []
    for (const item of content.items) {
      // Marked-content items carry no text and no position.
      if (!('str' in item)) continue
      const t = item as { str: string; width: number; transform: number[] }
      if (!t.str) continue
      pieces.push({ x: t.transform[4], y: t.transform[5], w: t.width ?? 0, s: t.str })
    }
    if (!pieces.length) continue

    // Top of the page down, then left to right within a line.
    pieces.sort((a, b) => b.y - a.y || a.x - b.x)

    const lines: { x: number; text: string }[] = []
    let run: Piece[] = []
    let runY: number | null = null

    const flush = () => {
      if (!run.length) return
      run.sort((a, b) => a.x - b.x)
      let text = ''
      let cursor: number | null = null
      for (const p of run) {
        // PDFs often emit a word at a time with no space of their own, so the
        // gap on the page is the only thing that says where one word ends.
        if (cursor !== null && p.x - cursor > 1) text += ' '
        text += p.s
        cursor = p.x + p.w
      }
      text = text.replace(/\s+/g, ' ').trim()
      if (text) lines.push({ x: run[0].x, text })
      run = []
    }

    for (const p of pieces) {
      // Glyphs on one printed line share a baseline within a point or two.
      if (runY === null || Math.abs(p.y - runY) <= 2) {
        run.push(p)
        if (runY === null) runY = p.y
      } else {
        flush()
        run = [p]
        runY = p.y
      }
    }
    flush()
    if (!lines.length) continue

    // Re-indent from the page's own left edge rather than an assumed margin,
    // so a script typeset with unusual margins still comes back in proportion.
    const left = Math.min(...lines.map((l) => l.x))
    // 12pt Courier, the screenplay standard, is 7.2pt per character.
    const COL = 7.2

    const out: string[] = []
    for (const l of lines) {
      // Page furniture: a bare page number, and the (CONTINUED) markers that a
      // production draft carries at the top and bottom of every page. Both
      // would read as action lines.
      if (/^\d{1,3}\.?$/.test(l.text)) continue
      if (/^\(?\s*(MORE|CONTINUED|CONT'D)\s*\)?\.?$/i.test(l.text)) continue
      const indent = Math.max(0, Math.round((l.x - left) / COL))
      out.push(' '.repeat(indent) + l.text)
    }
    pages.push(out.join('\n'))
  }

  // A page break in a screenplay is not a paragraph break - a speech routinely
  // runs across one - so pages are joined with a single blank line and left for
  // the breakdown to read as continuous text.
  return pages.join('\n\n').replace(/\n{4,}/g, '\n\n\n').trim()
}
