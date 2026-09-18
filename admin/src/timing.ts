import type { Beat } from './insforge'

// Dialogue -> clip length.
//
// The estimate only has to be good to about half a grid step, because MiniMax
// H3 quantizes length to 17k+5 frames: at 24fps that is 0.708s per step, so
// precision past ~0.35s cannot be expressed in the output anyway. A syllable
// count with a pause model comfortably clears that bar for typical shot
// lengths, which is why this is arithmetic rather than a TTS render.

export const FPS = 24
// Frame counts must satisfy length % 17 == 5. Both bounds below already do.
const GRID = 17
const GRID_OFFSET = 5
// The model's trained range: 124 frames = 5.17s, 362 = 15.08s. Outside it the
// model is documented as untested, so estimates clamp rather than extrapolate.
export const MIN_FRAMES = 124
export const MAX_FRAMES = 362

// Natural English speech runs ~4-6 syllables/sec; 5 is the middle.
const SYLLABLES_PER_SEC = 5.0
const SPEAKER_CHANGE_PAUSE = 0.5
const COMMA_PAUSE = 0.2
const SENTENCE_PAUSE = 0.5
// A parenthetical ("(quietly)", "(beat)") is not spoken but implies one.
const PARENTHETICAL_PAUSE = 0.3
// Text-derived estimates systematically undershoot: performance is not
// continuous speech. This covers breath, delivery and staging slack.
const PADDING = 1.15
// Shots with no dialogue get a length from staging, not speech, so they fall
// back to the value the official MiniMax template ships with.
export const DEFAULT_SILENT_SECONDS = 5

// Classic English syllable heuristic: count vowel groups, drop a silent
// trailing 'e', floor at one per word. Wrong on some words, but the errors are
// symmetric across a line and wash out well below one grid step.
function countSyllables(text: string): number {
  const words = text.toLowerCase().split(/[^a-z']+/).filter(Boolean)
  let total = 0
  for (const raw of words) {
    const word = raw.replace(/[^a-z]/g, '')
    if (!word) continue
    if (word.length <= 3) {
      total += 1
      continue
    }
    const trimmed = word.replace(/(?:[^laeiouy]es|ed|[^laeiouy]e)$/, '').replace(/^y/, '')
    const groups = trimmed.match(/[aeiouy]{1,2}/g)
    total += groups ? groups.length : 1
  }
  return total
}

function pauseSeconds(line: string): number {
  const commas = (line.match(/[,;:]/g) ?? []).length
  const sentences = (line.match(/[.!?]+/g) ?? []).length
  return commas * COMMA_PAUSE + sentences * SENTENCE_PAUSE
}

/**
 * Spoken length of a beat's dialogue in seconds, before clamping or snapping.
 * Returns null when the beat has no dialogue at all.
 */
export function estimateDialogueSeconds(beat: Beat): number | null {
  const lines = beat.dialogue ?? []
  if (lines.length === 0) return null

  let seconds = 0
  let previousCharacter: string | null = null
  for (const entry of lines) {
    seconds += countSyllables(entry.line) / SYLLABLES_PER_SEC
    seconds += pauseSeconds(entry.line)
    if (entry.parenthetical) seconds += PARENTHETICAL_PAUSE
    if (previousCharacter !== null && previousCharacter !== entry.character) {
      seconds += SPEAKER_CHANGE_PAUSE
    }
    previousCharacter = entry.character
  }
  return seconds * PADDING
}

/** Snap a raw frame count up onto the 17k+5 grid, then clamp to the trained range. */
export function snapFrames(frames: number): number {
  const raw = Math.max(GRID_OFFSET, Math.round(frames))
  const snapped = raw + ((GRID_OFFSET - (raw % GRID)) % GRID) + (raw % GRID > GRID_OFFSET ? GRID : 0)
  return Math.min(MAX_FRAMES, Math.max(MIN_FRAMES, snapped))
}

export function secondsToFrames(seconds: number): number {
  return snapFrames(seconds * FPS)
}

export function framesToSeconds(frames: number): number {
  return frames / FPS
}

/**
 * The suggested frame count for a beat, and whether the dialogue overruns what
 * a single clip can hold - the caller surfaces that as a prompt to split the
 * beat across shots rather than silently truncating the speech.
 */
// A silent beat gets its length from its action instead. This is a rougher
// guess than the dialogue timing - screen time for action is a directorial
// choice, not a measurable quantity - but a beat describing three distinct
// movements plausibly wants longer than one describing a held look, and a flat
// 5 seconds for both is worse than an informed estimate.
//
// The model is: a shot needs a moment to read before anything happens, each
// distinct action reads in roughly two seconds, and a named camera move takes
// time of its own regardless of what the subject does.
const SETTLE_SECONDS = 1.5
const SECONDS_PER_ACTION = 2.2
const SLOW_CAMERA_SECONDS = 4.0

// Deliberate moves that eat screen time on their own. A cut or a static frame
// adds nothing, so they are not listed.
const SLOW_CAMERA = /(slow(ly)?\s+)?(push[- ]?in|pull[- ]?back|dolly|track(ing)?|orbit|crane|tilt|pan|zoom|rack[- ]focus|reveal)/i

/** Split action prose into distinct beats of movement. */
function countActions(text: string): number {
  const cleaned = text.replace(/\s+/g, ' ').trim()
  if (!cleaned) return 0
  // Sentences, plus clauses joined by an explicit sequence word - "she stands,
  // then crosses to the window" is two actions, not one.
  const parts = cleaned
    .split(/(?<=[.!?])\s+|\s*;\s*|\s+(?:then|before|after which|and then)\s+/i)
    .map((p) => p.trim())
    .filter((p) => p.length > 2)
  return Math.max(1, parts.length)
}

/**
 * Screen time implied by a beat's action, or null when it describes nothing.
 * Falls back to the summary, which is often the only description a generated
 * beat has.
 */
export function estimateActionSeconds(beat: Pick<Beat, 'action_text' | 'summary'>): number | null {
  const text = (beat.action_text ?? '').trim() || (beat.summary ?? '').trim()
  if (!text) return null

  const actions = countActions(text)
  let seconds = SETTLE_SECONDS + actions * SECONDS_PER_ACTION

  // A slow move has its own duration; the shot cannot be shorter than the move.
  if (SLOW_CAMERA.test(text)) seconds = Math.max(seconds, SLOW_CAMERA_SECONDS + SETTLE_SECONDS)

  return seconds
}

export function suggestFramesForBeat(beat: Beat): {
  frames: number
  estimatedSeconds: number
  hasDialogue: boolean
  overruns: boolean
  /** Which input decided the length - useful to show, since they disagree often. */
  driver: 'dialogue' | 'action' | 'default'
} {
  const speech = estimateDialogueSeconds(beat)
  const action = estimateActionSeconds(beat)

  // When a beat has both, take the longer rather than the sum: action normally
  // plays under or around the dialogue rather than after it. Adding them would
  // roughly double every dialogue beat.
  let seconds: number
  let driver: 'dialogue' | 'action' | 'default'
  if (speech !== null && action !== null) {
    seconds = Math.max(speech, action)
    driver = speech >= action ? 'dialogue' : 'action'
  } else if (speech !== null) {
    seconds = speech
    driver = 'dialogue'
  } else if (action !== null) {
    seconds = action
    driver = 'action'
  } else {
    seconds = DEFAULT_SILENT_SECONDS
    driver = 'default'
  }

  return {
    frames: secondsToFrames(seconds),
    estimatedSeconds: seconds,
    hasDialogue: speech !== null,
    overruns: seconds * FPS > MAX_FRAMES,
    driver
  }
}
