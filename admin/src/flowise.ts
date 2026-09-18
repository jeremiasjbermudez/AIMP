// One place for talking to Flowise. This was copy-pasted into five panels in
// two subtly different shapes: some sent `question: JSON.stringify(body)`
// (Shots, Qwen Cleanup, MiniMax) and some sent the bare string
// (Characters, Beats). Both are supported here by type, so callers stop
// having to remember which flow wants which.

export type RunStatus = { state: 'running' | 'done' | 'error'; message: string }

/**
 * A file handed to a flow as `$flow.uploads` - how 4-Panoramic-Generator takes
 * a custom panorama.
 *
 * The type MUST be 'url', not 'file'. Flowise intercepts uploads of type 'file'
 * in buildChatflow: it writes them to its own storage, rewrites the entry to
 * `type: 'stored-file'` and DELETES the `data` field. A flow that reads
 * `$flow.uploads[].data` then sees nothing and silently falls through to its
 * normal path. 'url' is passed through untouched, data URL and all.
 */
export type FlowUpload = { data: string; type: 'url'; name: string; mime: string }

// ---------------------------------------------------------------- the queue
//
// One GPU, one job at a time.
//
// Pressing Generate for a second character used to SUBMIT that work rather than
// queue it: both runs pushed their prompts into ComfyUI and then sat waiting.
// ComfyUI does execute prompts one at a time, so nothing raced - but with the
// card at 97% full (a 25 GB model set in 32 GB of VRAM) it cannot hold the
// weights across a prompt boundary, so it dumped and reloaded the whole 25 GB
// between jobs. Measured on this machine: ~25 GB read and ~18 seconds of disk
// for about 2 seconds of rendering, over and over, with the GPU at 1%.
//
// Queuing means waiting in line, not handing over the load and then waiting.
// So a job that needs the GPU now waits here, in the browser, and is not sent
// until the one in front of it has answered.
//
// Nothing else changes: every panel calls triggerFlow exactly as before and
// sees the same result. The only difference is when the request leaves.
//
// Flows are listed explicitly rather than queued by default, so a flow nobody
// thought about behaves exactly as it does today instead of quietly blocking
// behind a three-minute render.
const GPU_FLOWS: Set<string> = new Set(
  [
    import.meta.env.VITE_IMAGE_EDIT_ID,
    import.meta.env.VITE_QWEN_IMAGE_EDIT_ID,
    import.meta.env.VITE_Z_IMAGE_ID,
    import.meta.env.VITE_CHARACTER_GENERATOR_ID,
    import.meta.env.VITE_CHARACTER_WARDROBE_ID,
    import.meta.env.VITE_CHARACTER_QA_SHOTS_ID,
    import.meta.env.VITE_PANORAMIC_GENERATOR_ID,
    import.meta.env.VITE_WORLD_BUILDER_ID,
    import.meta.env.VITE_HYWORLD_ID,
    import.meta.env.VITE_GS_CLEANER_ID,
    import.meta.env.VITE_QWEN_CLEANUP_ID,
    import.meta.env.VITE_FACE_FIX_ID,
    import.meta.env.VITE_FACE_QA_ID,
    import.meta.env.VITE_APPLY_LUT_ID,
    import.meta.env.VITE_MINIMAX_I2V_ID,
    import.meta.env.VITE_MINIMAX_T2V_ID,
    import.meta.env.VITE_MINIMAX_REF_ID,
    import.meta.env.VITE_MINIMAX_V2V_ID,
    import.meta.env.VITE_MINIMAX_EXTEND_ID,
    import.meta.env.VITE_MINIMAX_CLIP_GENERATOR_ID,
    import.meta.env.VITE_TRIGGER_ORCHESTRATOR_ID
  ].filter(Boolean) as string[]
)

/**
 * The Director plans with an LLM and renders with the GPU through the same
 * flow id, so the id alone cannot say which this is. Only the modes that reach
 * ComfyUI queue; drafting a shot list does not wait behind a render.
 */
function needsGpu(flowId: string, input: string | object): boolean {
  if (GPU_FLOWS.has(flowId)) return true
  if (flowId !== import.meta.env.VITE_DIRECTOR_ID) return false
  const mode = typeof input === 'object' && input !== null ? (input as { mode?: string }).mode : undefined
  return mode === 'render' || mode === 'assemble'
}

// The line itself: a promise chain, so each job starts when the one before it
// settles. `catch` on the tail matters - without it one failed render would
// break the chain and everything behind it would never run.
let tail: Promise<unknown> = Promise.resolve()
let waiting = 0

/** How many GPU jobs are queued or running right now. For anything that wants to say so. */
export function gpuQueueDepth(): number {
  return waiting
}

function enqueue<T>(work: () => Promise<T>): Promise<T> {
  waiting++
  const mine = tail.then(work, work)
  tail = mine.catch(() => undefined)
  return mine.finally(() => {
    waiting--
  })
}

export async function triggerFlow(
  flowId: string,
  input: string | object,
  uploads?: FlowUpload[]
): Promise<RunStatus> {
  // GPU work waits its turn; everything else goes straight out as before.
  if (needsGpu(flowId, input)) return enqueue(() => send(flowId, input, uploads))
  return send(flowId, input, uploads)
}

async function send(
  flowId: string,
  input: string | object,
  uploads?: FlowUpload[]
): Promise<RunStatus> {
  const url = `${import.meta.env.VITE_FLOWISE_URL}/api/v1/prediction/${flowId}`
  try {
    const body: Record<string, unknown> = {
      question: typeof input === 'string' ? input : JSON.stringify(input)
    }
    if (uploads && uploads.length > 0) body.uploads = uploads
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${import.meta.env.VITE_FLOWISE_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    })
    const data = await res.json()
    if (!res.ok) return { state: 'error', message: data?.message ?? `HTTP ${res.status}` }
    return { state: 'done', message: typeof data.text === 'string' ? data.text : JSON.stringify(data) }
  } catch (e) {
    return { state: 'error', message: e instanceof Error ? e.message : String(e) }
  }
}

// 2-Trigger-Orchestration takes a bare scope token: "A1", "A1S2", "A1S2B3",
// optionally followed by --force / --force-pano / --force-world.
export function triggerOrchestrator(scope: string): Promise<RunStatus> {
  return triggerFlow(import.meta.env.VITE_TRIGGER_ORCHESTRATOR_ID, scope)
}

// A flow that answers with JSON returns it as a string in `text`. This unwraps
// that, so callers get either the parsed payload or a readable error rather
// than each re-implementing the same try/catch.
export function parseFlowJson<T>(status: RunStatus): { ok: true; data: T } | { ok: false; message: string } {
  if (status.state === 'error') return { ok: false, message: status.message }
  try {
    const parsed = JSON.parse(status.message) as T & { error?: string }
    if (parsed && typeof parsed === 'object' && parsed.error) return { ok: false, message: parsed.error }
    return { ok: true, data: parsed }
  } catch {
    return { ok: false, message: 'Unexpected response: ' + status.message.slice(0, 200) }
  }
}


/** Read a File into the shape Flowise expects on `uploads`. */
export function fileToUpload(file: File): Promise<FlowUpload> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () =>
      resolve({ data: String(reader.result), type: 'url', name: file.name, mime: file.type || 'image/png' })
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(file)
  })
}
