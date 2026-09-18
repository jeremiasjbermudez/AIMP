import type { Beat } from './insforge'

// MiniMax H3 dialogue tagging, per its own prompt guide:
//
//   The young woman with a quiet, breathy voice (S1) says: <d>[English] I get
//   off at the next station.</d>
//
// Two parts matter and we were only emitting one of them:
//
//   1. <d>[Language] ...</d> - the brackets around the language are part of the
//      format, and the words inside are preserved verbatim, never translated.
//   2. (S1)/(S2) speaker IDs - stable per speaker for the whole clip, assigned
//      once and reused. Without them a multi-character beat gives the model no
//      way to tell which voice owns which line, which is what produced
//      unintelligible speech on two-hander shots.

export const DEFAULT_LANGUAGE = 'English'

/** Stable (S1), (S2)... ids in order of first appearance in the beat. */
export function speakerIds(beat: Beat): Record<string, string> {
  const ids: Record<string, string> = {}
  let next = 1
  for (const entry of beat.dialogue ?? []) {
    if (!ids[entry.character]) {
      ids[entry.character] = `S${next}`
      next += 1
    }
  }
  return ids
}

/**
 * Dialogue lines in MiniMax's documented speaker form. `subjectLabel` lets the
 * reference-to-video prompt refer to "<Subject 2> (S1) says:" while the
 * image/text modes, which have no subject definitions, use the plain name.
 */
export function dialogueLines(
  beat: Beat,
  subjectLabel?: (character: string) => string | null
): string[] {
  const ids = speakerIds(beat)
  return (beat.dialogue ?? []).map((entry) => {
    const id = ids[entry.character]
    const label = subjectLabel?.(entry.character) ?? null
    // MiniMax's own example puts the delivery descriptor before the id -
    // "...with a quiet, breathy voice (S1) says:" - so a parenthetical rides
    // with the name rather than splitting the id from the verb.
    const name = label ?? entry.character
    const descriptor = entry.parenthetical ? `, ${entry.parenthetical}` : ''
    return `${name}${descriptor} (${id}) says: <d>[${DEFAULT_LANGUAGE}] ${entry.line}</d>`
  })
}

/** "S1 = ANNA, S2 = BEN" - stated once so the ids are anchored to names. */
export function speakerRoster(beat: Beat): string {
  const ids = speakerIds(beat)
  const entries = Object.entries(ids)
  if (entries.length === 0) return ''
  return entries.map(([name, id]) => `${id} = ${name}`).join(', ')
}
