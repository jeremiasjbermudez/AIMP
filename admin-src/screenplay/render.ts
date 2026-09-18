import type { DraftBeat, ScreenplayTree } from './model'
import { normaliseIntExt } from './model'

// Renders the tree to the exact screenplay text the pipeline's parser expects,
// and records which lines each beat and scene occupies so beats.line_start /
// line_end / source_hash can be written to match.

const ACTION_WRAP = 60
const DIALOGUE_WRAP = 35

function wrap(text: string, width: number): string[] {
  const out: string[] = []
  for (const para of text.split(/\n+/)) {
    let line = ''
    for (const word of para.trim().split(/\s+/).filter(Boolean)) {
      if (line && (line + ' ' + word).length > width) {
        out.push(line)
        line = word
      } else {
        line = line ? line + ' ' + word : word
      }
    }
    if (line) out.push(line)
    out.push('')
  }
  while (out.length && out[out.length - 1] === '') out.pop()
  return out
}

// The scene-heading regex is unanchored: a line of action reading "Room 4 INT."
// would be read as a scene heading and silently invent a scene, shifting every
// scene number after it. Spell the digits out instead.
const HEADING_LIKE = /(\d+)\s+(INT|EXT)\b/
const WORDS = ['zero','one','two','three','four','five','six','seven','eight','nine']
function sanitize(line: string): string {
  if (!HEADING_LIKE.test(line)) return line
  return line.replace(/\b(\d+)(?=\s+(?:INT|EXT)\b)/g, (d) =>
    d.split('').map((c) => WORDS[Number(c)]).join('-')
  )
}

/** djb2, byte-for-byte the hash 1-Beat-Generator computes for a scene. */
export function djb2(str: string): string {
  let h = 5381
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) | 0
  return (h >>> 0).toString(16)
}

export type ExportResult = {
  text: string
  /** beat id (or index key) -> 1-based inclusive line range */
  beatSpans: Map<DraftBeat, { start: number; end: number }>
  /** per-scene source hash, keyed by the beats belonging to it */
  sceneHash: Map<DraftBeat, string>
}

export function renderScreenplay(tree: ScreenplayTree, title: string): ExportResult {
  const lines: string[] = []
  const beatSpans = new Map<DraftBeat, { start: number; end: number }>()
  const sceneRanges: { beats: DraftBeat[]; start: number; end: number }[] = []

  lines.push(title.toUpperCase(), '')

  tree.acts.forEach((act, ai) => {
    act.scenes.forEach((scene) => {
      const sceneStart = lines.length + 1
      const n = scene.beats[0]?.scene_number ?? 0
      const where = (scene.location ?? 'UNTITLED LOCATION').trim().toUpperCase()
      const when = (scene.time_of_day ?? '').trim().toUpperCase()
      const ie = normaliseIntExt(scene.int_ext)
      lines.push(`${n} ${ie}. ${where}${when ? ' - ' + when : ''} ${n}`)
      lines.push('')

      for (const beat of scene.beats) {
        const beatStart = lines.length + 1
        if (beat.action_text && beat.action_text.trim()) {
          for (const l of wrap(beat.action_text, ACTION_WRAP)) lines.push(sanitize(l))
          lines.push('')
        }
        for (const d of beat.dialogue) {
          if (!d.character.trim() && !d.line.trim()) continue
          // presence turns into the standard cue suffix
          const who = beat.characters.find((c) => c.name === d.character)
          const suffix =
            who?.presence === 'voice_only' ? ' (V.O.)' : who?.presence === 'off_screen' ? ' (O.S.)' : ''
          lines.push(d.character.trim().toUpperCase() + suffix)
          if (d.parenthetical && d.parenthetical.trim()) lines.push(`(${d.parenthetical.trim()})`)
          for (const l of wrap(d.line, DIALOGUE_WRAP)) lines.push(sanitize(l))
          lines.push('')
        }
        // A beat with nothing in it still needs a valid, non-empty range.
        if (lines.length + 1 === beatStart) lines.push('')
        beatSpans.set(beat, { start: beatStart, end: lines.length })
      }

      sceneRanges.push({ beats: scene.beats, start: sceneStart, end: lines.length })
    })

    lines.push(`END OF ACT ${ai + 1}`, '')
  })

  const text = lines.join('\n').replace(/\n+$/, '') + '\n'

  // Hash from the FINAL string, split exactly as the flows split it, so the
  // value matches what 1-Beat-Generator would compute for the same text.
  const finalLines = text.split(/\r\n|\r|\n/)
  const sceneHash = new Map<DraftBeat, string>()
  for (const r of sceneRanges) {
    const raw = finalLines.slice(r.start - 1, r.end).join('\n')
    const h = djb2(`v3::${raw}`)
    for (const b of r.beats) sceneHash.set(b, h)
  }

  return { text, beatSpans, sceneHash }
}
