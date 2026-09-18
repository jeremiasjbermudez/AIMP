/**
 * What is installed, and how the app behaves about what is not.
 *
 * Features cross module boundaries: the relight control sits on an image card
 * in the Image Edit tab, the grade control sits on a clip card in the video
 * tabs, the face repair sits on both. Those controls live in the shell so any
 * panel can use them, but the flows and tables behind them arrive with their
 * own module.
 *
 * So a control that belongs to a module you have not installed must not
 * pretend to work, and must not disappear either - a button that vanishes
 * teaches nothing, while one that says what it needs teaches exactly the right
 * thing. It stays where it is, disabled, naming the module and the command
 * that would install it.
 */
import { INSTALLED_MODULES } from './modules.generated'

/** Modules with a tab in this build. */
export function isInstalled(module: string): boolean {
  return INSTALLED_MODULES.includes(module)
}

/**
 * Is the flow behind a control actually reachable?
 *
 * Two ways it might not be: the module was never installed, or it was and its
 * id has not been written yet. Both mean the same to a button, and checking
 * the id catches an interrupted install that the module list would not.
 */
export function hasFlow(flowId: string | undefined): boolean {
  return typeof flowId === 'string' && flowId.trim().length > 0
}

/** The command that installs a module, for telling someone what to run. */
export function installCommand(module: string): string {
  return `.\\install-module.ps1 -Module ${module}`
}

/** What each module is called in a sentence, for the placeholder text. */
export const MODULE_TITLES: Record<string, string> = {
  screenplay: 'Screenplay & structure',
  characters: 'Characters & props',
  imaging: 'Image generation & editing',
  world: 'Locations & 3D worlds',
  camera: 'Cameras & plates',
  director: 'Director & shot lists',
  video: 'Video generation',
  faceqa: 'Face QA & repair',
  colour: 'Colour & lighting',
  audio: 'Score & voice',
  delivery: 'Editorial hand-off',
  tools: 'Housekeeping',
  library: 'Reference library'
}
