/**
 * What differs between the video tabs, in one table.
 *
 * `MinimaxVideoPanel` serves every video tab from one component, which is
 * right - the prompt, camera, resolution, generations list, extend, grade and
 * delete are identical for all of them. What was not right is HOW the
 * differences were expressed: two dozen `kind === 'i2v' ? ... : kind === 't2v'
 * ? ...` ternaries scattered through 1300 lines, three of which computed the
 * same thing in three different places.
 *
 * With two kinds that is merely untidy. With four it is a trap: every one of
 * those ternaries silently keeps working while quietly giving the new kind
 * whatever the final `else` happened to be. A missing branch does not fail, it
 * mislabels - which is the worst kind of bug to go looking for.
 *
 * So the differences live here as data. Adding a kind means adding one entry
 * and being told by the compiler what it must contain.
 */
import type { MinimaxClipMode } from './insforge'
import type { CameraCategory } from './camera'

export type Kind = 'i2v' | 't2v' | 'ref' | 'v2v' | 'control'

export type KindState = {
  prompt: string
  hasFirstImage: boolean
  refCount: number
  hasSourceClip: boolean
  hasControlVideo: boolean
}

export type KindConfig = {
  heading: string
  flowId: string
  /** Clip modes this tab lists. 'extend' appears everywhere: an extension continues a clip from any tab. */
  listModes: MinimaxClipMode[]
  /** The mode written on a new row. i2v depends on whether a last frame was given. */
  rowMode: (imageMode: 'first' | 'first_last') => MinimaxClipMode
  /** Which inputs this kind shows. */
  usesFirstImage: boolean
  usesRefPool: boolean
  /** Transforms an existing clip rather than generating from nothing. */
  usesSourceClip: boolean
  /** Driven by a depth / pose / edge video through the Fun ControlNet. */
  usesControlVideo: boolean
  /** Spectrum acceleration is not offered on Reference to Video. */
  allowSpectrum: boolean
  /**
   * Camera axes that make sense here.
   *
   * A supplied first frame has already fixed the shot size, angle and lens, so
   * asserting them again can only fight the picture - the same failure as
   * telling an anime reference it is "a photograph". Only text-to-video is
   * choosing them from nothing.
   */
  cameraAxes: CameraCategory[]
  /** What is still missing before this kind can render. '' when ready. */
  requires: (s: KindState) => string
  /** Placeholder for the prompt box - what this kind wants described. */
  promptHint: string
}

const ALL_AXES: CameraCategory[] = ['movement', 'framing', 'angle', 'lens', 'look']
const MOVE_AND_LOOK: CameraCategory[] = ['movement', 'look']

export const VIDEO_KINDS: Record<Kind, KindConfig> = {
  i2v: {
    heading: 'Image to Video (MiniMax H3)',
    flowId: import.meta.env.VITE_MINIMAX_I2V_ID,
    listModes: ['i2v_first', 'i2v_first_last', 'extend'],
    rowMode: (imageMode) => (imageMode === 'first_last' ? 'i2v_first_last' : 'i2v_first'),
    usesFirstImage: true,
    usesRefPool: false,
    usesSourceClip: false,
    usesControlVideo: false,
    allowSpectrum: true,
    cameraAxes: MOVE_AND_LOOK,
    requires: (s) => (!s.prompt.trim() ? 'a prompt' : !s.hasFirstImage ? 'a first image' : ''),
    promptHint: 'Describe the motion, camera and action that should play out from the frame(s).'
  },
  t2v: {
    heading: 'Text to Video (MiniMax H3)',
    flowId: import.meta.env.VITE_MINIMAX_T2V_ID,
    listModes: ['t2v', 'extend'],
    rowMode: () => 't2v',
    usesFirstImage: false,
    usesRefPool: false,
    usesSourceClip: false,
    usesControlVideo: false,
    allowSpectrum: true,
    cameraAxes: ALL_AXES,
    requires: (s) => (!s.prompt.trim() ? 'a prompt' : ''),
    promptHint: 'Describe the shot: style, subject, action, camera and setting.'
  },
  ref: {
    heading: 'Reference to Video (MiniMax H3)',
    flowId: import.meta.env.VITE_MINIMAX_REF_ID,
    listModes: ['ref', 'extend'],
    rowMode: () => 'ref',
    usesFirstImage: false,
    usesRefPool: true,
    usesSourceClip: false,
    usesControlVideo: false,
    allowSpectrum: false,
    cameraAxes: MOVE_AND_LOOK,
    requires: (s) =>
      !s.prompt.trim()
        ? 'a prompt'
        : s.refCount === 0
          ? 'at least one reference image — click one above to pick it'
          : '',
    promptHint: 'Describe the shot: style, subject, action, camera and setting.'
  },
  v2v: {
    heading: 'Video to Video (MiniMax H3)',
    flowId: import.meta.env.VITE_MINIMAX_V2V_ID,
    listModes: ['v2v'],
    rowMode: () => 'v2v',
    usesFirstImage: false,
    usesRefPool: true,
    usesSourceClip: true,
    usesControlVideo: false,
    allowSpectrum: false,
    // The source clip already fixes framing, angle, lens AND the camera move -
    // the performance is what is being preserved. Only the optical look is
    // still open, so only that is offered.
    cameraAxes: ['look'],
    requires: (s) =>
      !s.prompt.trim() ? 'a prompt' : !s.hasSourceClip ? 'the clip to transform' : '',
    promptHint:
      'Describe the look to transfer, or who the character should become. The performance comes from the source clip.'
  },
  control: {
    heading: 'Control to Video (MiniMax H3)',
    flowId: import.meta.env.VITE_MINIMAX_CONTROL_ID,
    listModes: ['control'],
    rowMode: () => 'control',
    usesFirstImage: false,
    // Optional here: character sheets keep an identity on every frame, and a
    // plate can be given as "the location". The control video needs neither.
    usesRefPool: true,
    usesSourceClip: false,
    usesControlVideo: true,
    allowSpectrum: false,
    // The control video fixes framing, angle and the camera move. Only the
    // optical look is still open.
    cameraAxes: ['look'],
    requires: (s) =>
      !s.prompt.trim() ? 'a prompt' : !s.hasControlVideo ? 'a control video' : '',
    promptHint:
      'Describe the shot: style, subject, setting. Layout and motion come from the control video.'
  }
}
