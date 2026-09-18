/**
 * Turning a Face QA score into a decision.
 *
 * The gallery tells you whether the drift is real. This works out what can be
 * done about it, which is not a judgement call - it falls out of where the
 * clean frames are and what Extend needs to work.
 */

export type FrameScore = { frame: number; time: number; similarity: number; facePx?: number }

/** How many frames Extend hands off from. Must match GUIDE_FRAMES in the node. */
export const GUIDE_FRAMES = 22

export type Plan =
  | { kind: 'clean' }
  | { kind: 'retake'; anchorFrame: number; anchorTime: number; firstBadTime: number }
  | { kind: 'reroll'; firstBadTime: number }
  /** Never matched at any sampled frame - not drift, and a retake cannot fix it. */
  | { kind: 'nomatch'; best: number }

/**
 * Where the clip stops being usable, and what to do about it.
 *
 * Extend continues from a 22-frame window ENDING at the anchor, so the anchor
 * is the last sampled frame before the drift: everything behind it scored
 * clean, and the hand-off happens before the face goes.
 *
 * The honest caveat is sampling. Scores come from every Nth frame, so at
 * everyNth=6 a 22-frame window holds three or four samples and the frames
 * between them were never looked at. The drift can therefore begin a few frames
 * before the anchor without being seen. Checking that the samples inside the
 * window pass would look like protection against this and is not - every
 * candidate is earlier than the first bad sample, so that test can never fail.
 * It is left out rather than written as reassurance.
 *
 * To tighten it, sample more densely (lower everyNth) before scoring.
 */
export function planFrom(frames: FrameScore[], good: number): Plan {
  if (frames.length === 0) return { kind: 'clean' }
  const sorted = [...frames].sort((a, b) => a.frame - b.frame)
  const firstBadAt = sorted.findIndex((f) => f.similarity < good)
  if (firstBadAt < 0) return { kind: 'clean' }

  // Nothing ever matched. Drift means starting right and going wrong, so a clip
  // that is below the bar at every sampled frame is a different problem -
  // usually the wrong character picked, or a shot too distant or too far in
  // profile for the recogniser to work with. Neither a retake nor a new first
  // frame addresses that, and offering them would send you rendering for
  // nothing.
  const best = Math.max(...sorted.map((f) => f.similarity))
  if (best < good) return { kind: 'nomatch', best }

  const anchor = firstBadAt > 0 ? sorted[firstBadAt - 1] : null
  // Extend needs a full window behind the anchor; a drift inside the first 22
  // frames leaves nowhere to hand off from, so the clip has to be remade from a
  // corrected first frame rather than continued.
  if (!anchor || anchor.frame < GUIDE_FRAMES - 1) {
    return { kind: 'reroll', firstBadTime: sorted[firstBadAt].time }
  }
  return {
    kind: 'retake',
    anchorFrame: anchor.frame,
    anchorTime: anchor.time,
    firstBadTime: sorted[firstBadAt].time
  }
}
