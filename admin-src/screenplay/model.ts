import type { Beat } from '../insforge'

// The screenplay is edited as a tree: acts contain scenes contain beats.
//
// Nothing in the UI sets act_number / scene_number / beat_number /
// sequence_index by hand. They are derived from position by renumber(), which
// runs after every mutation. That is what makes "shimmy a beat in and the rest
// adjusts" fall out for free instead of being a special case.

export type DraftBeat = {
  // null until saved - a beat that has never been written to the database.
  id: string | null
  act_number: number
  scene_number: number | null
  beat_number: number | null
  beat_code: string | null
  sequence_index: number
  scene_heading: string | null
  int_ext: string | null
  location: string | null
  time_of_day: string | null
  summary: string
  action_text: string | null
  raw_text: string
  line_start: number
  line_end: number
  source_hash: string | null
  characters: { name: string; presence?: 'in_scene' | 'voice_only' | 'off_screen'; blocking?: string }[]
  objects: { name: string; notes?: string }[]
  dialogue: { character: string; parenthetical?: string | null; line: string }[]
}

export type SceneNode = {
  scene_heading: string | null
  int_ext: string | null
  location: string | null
  time_of_day: string | null
  beats: DraftBeat[]
}

export type ActNode = { scenes: SceneNode[] }
export type ScreenplayTree = { acts: ActNode[] }

// ---------------------------------------------------------------- building

export function buildTree(beats: Beat[]): ScreenplayTree {
  const ordered = [...beats].sort((a, b) => a.sequence_index - b.sequence_index)
  const acts: ActNode[] = []
  const actNumbers: number[] = []

  for (const b of ordered) {
    let ai = actNumbers.indexOf(b.act_number)
    if (ai === -1) {
      actNumbers.push(b.act_number)
      acts.push({ scenes: [] })
      ai = acts.length - 1
    }
    const act = acts[ai]
    let scene = act.scenes[act.scenes.length - 1]
    // A new scene starts whenever the scene number changes. Comparing against
    // the last scene rather than searching keeps screenplay order intact even
    // if numbering is odd.
    if (!scene || scene.beats[0]?.scene_number !== b.scene_number) {
      scene = {
        scene_heading: b.scene_heading,
        int_ext: b.int_ext,
        location: b.location,
        time_of_day: b.time_of_day,
        beats: []
      }
      act.scenes.push(scene)
    }
    scene.beats.push({ ...b } as DraftBeat)
  }
  return renumber({ acts })
}

export function emptyBeat(): DraftBeat {
  return {
    id: null,
    act_number: 1,
    scene_number: 1,
    beat_number: 1,
    beat_code: null,
    sequence_index: 0,
    scene_heading: null,
    int_ext: null,
    location: null,
    time_of_day: null,
    summary: '',
    action_text: '',
    raw_text: '',
    line_start: 0,
    line_end: 0,
    source_hash: null,
    characters: [],
    objects: [],
    dialogue: []
  }
}

export function emptyScene(): SceneNode {
  return { scene_heading: null, int_ext: 'INT', location: '', time_of_day: 'DAY', beats: [emptyBeat()] }
}

/** A brand new screenplay: Act 1, Scene 1, Beat 1. */
export function newScreenplay(): ScreenplayTree {
  return renumber({ acts: [{ scenes: [emptyScene()] }] })
}

// ------------------------------------------------------------- renumbering

/**
 * Assign every number from tree position. Scene numbers run CONTINUOUSLY
 * across acts (act 1 ending at S9 means act 2 starts at S10) because that is
 * the convention the screenplay parser and the rest of the pipeline expect.
 */
export function renumber(tree: ScreenplayTree): ScreenplayTree {
  let sceneCounter = 0
  let seq = 0

  tree.acts.forEach((act, ai) => {
    const actNumber = ai + 1
    act.scenes.forEach((scene) => {
      sceneCounter += 1
      const heading = renderHeading(scene, sceneCounter)
      scene.scene_heading = heading
      scene.beats.forEach((beat, bi) => {
        beat.act_number = actNumber
        beat.scene_number = sceneCounter
        beat.beat_number = bi + 1
        beat.beat_code = `A${actNumber}S${sceneCounter}B${bi + 1}`
        seq += 10
        beat.sequence_index = seq
        // Heading fields live on the scene; beats carry a denormalised copy
        // because that is how the pipeline's beats table is shaped.
        beat.scene_heading = heading
        // Normalised on the way out too, so a tree loaded from anywhere - an
        // older draft, a hand edit - cannot carry an invalid value into a save.
        beat.int_ext = normaliseIntExt(scene.int_ext)
        beat.location = scene.location
        beat.time_of_day = scene.time_of_day
      })
    })
  })
  return tree
}

/**
 * Coerce a heading prefix to one of the three values `beats_int_ext_check`
 * allows: INT, EXT or INT/EXT.
 *
 * The breakdown model writes this field and does not stick to those spellings -
 * "INT./EXT.", "Interior", "I/E" are all things it produces. The database
 * rejects anything else, so a whole breakdown failed on one heading with a
 * message naming a constraint rather than the scene. Normalising here means the
 * model's phrasing never decides whether a save succeeds.
 */
export function normaliseIntExt(raw: string | null | undefined): string {
  const v = String(raw ?? '').toUpperCase().replace(/[.\s]/g, '')
  const hasInt = v.includes('INT')
  const hasExt = v.includes('EXT')
  // Both, or the "I/E" shorthand, means the scene straddles the two.
  if ((hasInt && hasExt) || v === 'I/E' || v === 'IE') return 'INT/EXT'
  if (hasExt) return 'EXT'
  // INT is the default: unmarked scenes in a breakdown are far more often
  // interiors, and it is what renderHeading already fell back to.
  return 'INT'
}

/** `3 INT. THE CRYPT - NIGHT 3` - the number at both ends is the shooting-script convention. */
export function renderHeading(scene: SceneNode, sceneNumber: number): string {
  const where = (scene.location ?? '').trim().toUpperCase() || 'UNTITLED LOCATION'
  const when = (scene.time_of_day ?? '').trim().toUpperCase()
  const ie = normaliseIntExt(scene.int_ext)
  return `${sceneNumber} ${ie}. ${where}${when ? ' - ' + when : ''} ${sceneNumber}`
}

// ---------------------------------------------------------------- mutation
// Every mutation returns a NEW tree object so React re-renders, then renumbers.

function clone(tree: ScreenplayTree): ScreenplayTree {
  return {
    acts: tree.acts.map((a) => ({
      scenes: a.scenes.map((s) => ({ ...s, beats: s.beats.map((b) => ({ ...b })) }))
    }))
  }
}

export function addAct(tree: ScreenplayTree, atIndex?: number): ScreenplayTree {
  const t = clone(tree)
  const at = atIndex ?? t.acts.length
  t.acts.splice(at, 0, { scenes: [emptyScene()] })
  return renumber(t)
}

export function deleteAct(tree: ScreenplayTree, ai: number): ScreenplayTree {
  const t = clone(tree)
  t.acts.splice(ai, 1)
  if (t.acts.length === 0) t.acts.push({ scenes: [emptyScene()] })
  return renumber(t)
}

export function moveAct(tree: ScreenplayTree, ai: number, delta: number): ScreenplayTree {
  const t = clone(tree)
  const to = ai + delta
  if (to < 0 || to >= t.acts.length) return tree
  const [a] = t.acts.splice(ai, 1)
  t.acts.splice(to, 0, a)
  return renumber(t)
}

export function addScene(tree: ScreenplayTree, ai: number, atIndex?: number): ScreenplayTree {
  const t = clone(tree)
  const scenes = t.acts[ai].scenes
  scenes.splice(atIndex ?? scenes.length, 0, emptyScene())
  return renumber(t)
}

export function deleteScene(tree: ScreenplayTree, ai: number, si: number): ScreenplayTree {
  const t = clone(tree)
  t.acts[ai].scenes.splice(si, 1)
  if (t.acts[ai].scenes.length === 0) t.acts[ai].scenes.push(emptyScene())
  return renumber(t)
}

/** Move a scene within its act, or across the act boundary when it runs off either end. */
export function moveScene(tree: ScreenplayTree, ai: number, si: number, delta: number): ScreenplayTree {
  const t = clone(tree)
  const scenes = t.acts[ai].scenes
  const to = si + delta
  if (to >= 0 && to < scenes.length) {
    const [s] = scenes.splice(si, 1)
    scenes.splice(to, 0, s)
    return renumber(t)
  }
  const targetAct = ai + delta
  if (targetAct < 0 || targetAct >= t.acts.length) return tree
  const [s] = scenes.splice(si, 1)
  if (delta < 0) t.acts[targetAct].scenes.push(s)
  else t.acts[targetAct].scenes.unshift(s)
  if (scenes.length === 0) t.acts[ai].scenes.push(emptyScene())
  return renumber(t)
}

export function addBeat(tree: ScreenplayTree, ai: number, si: number, atIndex?: number): ScreenplayTree {
  const t = clone(tree)
  const beats = t.acts[ai].scenes[si].beats
  beats.splice(atIndex ?? beats.length, 0, emptyBeat())
  return renumber(t)
}

export function deleteBeat(tree: ScreenplayTree, ai: number, si: number, bi: number): ScreenplayTree {
  const t = clone(tree)
  const beats = t.acts[ai].scenes[si].beats
  beats.splice(bi, 1)
  if (beats.length === 0) beats.push(emptyBeat())
  return renumber(t)
}

/** Move a beat within its scene, or into the neighbouring scene when it runs off either end. */
export function moveBeat(tree: ScreenplayTree, ai: number, si: number, bi: number, delta: number): ScreenplayTree {
  const t = clone(tree)
  const beats = t.acts[ai].scenes[si].beats
  const to = bi + delta
  if (to >= 0 && to < beats.length) {
    const [b] = beats.splice(bi, 1)
    beats.splice(to, 0, b)
    return renumber(t)
  }
  const scenes = t.acts[ai].scenes
  const targetScene = si + delta
  if (targetScene < 0 || targetScene >= scenes.length) return tree
  const [b] = beats.splice(bi, 1)
  if (delta < 0) scenes[targetScene].beats.push(b)
  else scenes[targetScene].beats.unshift(b)
  if (beats.length === 0) beats.push(emptyBeat())
  return renumber(t)
}

export function updateBeat(
  tree: ScreenplayTree,
  ai: number,
  si: number,
  bi: number,
  fields: Partial<DraftBeat>
): ScreenplayTree {
  const t = clone(tree)
  Object.assign(t.acts[ai].scenes[si].beats[bi], fields)
  return t
}

export function updateScene(tree: ScreenplayTree, ai: number, si: number, fields: Partial<SceneNode>): ScreenplayTree {
  const t = clone(tree)
  Object.assign(t.acts[ai].scenes[si], fields)
  return renumber(t)
}

// ------------------------------------------------------------------ counts

export function flatten(tree: ScreenplayTree): DraftBeat[] {
  return tree.acts.flatMap((a) => a.scenes.flatMap((s) => s.beats))
}

export function countScenes(tree: ScreenplayTree): number {
  return tree.acts.reduce((n, a) => n + a.scenes.length, 0)
}
