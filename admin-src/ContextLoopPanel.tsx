import { useEffect, useState } from 'react'

/**
 * ComfyUI, embedded — for evaluating the MiniMax H3 Context Loop pack.
 *
 * Deliberately connected to NOTHING in this app. It reads no movie, writes no
 * row, triggers no flow. The pack's own runs land in
 * `output/h3_chains/<run_name>/`, away from the movie folders, so trying it
 * cannot disturb anything the Director made.
 *
 * Why an iframe rather than a built UI: the pack's controls ARE ComfyUI nodes —
 * the Production Plan, the Scene Prompt Editor, the Review Gate with its
 * approve/retry/reroll buttons. There is nothing to rebuild; the graph editor is
 * the interface. ComfyUI sends no X-Frame-Options and no frame-ancestors CSP,
 * so it frames cleanly.
 */
const COMFY = import.meta.env.VITE_COMFY_URL

// The pack's entry points. The advanced ones (2MP de-rope, V2V latent motion
// transfer) need node packs that are not installed here, so they are left out.
const WORKFLOWS = [
  ['I2V Normal - MiniMax H3 0.6.json', 'Start here. One first image per scene, scene-column editor.'],
  ['FL2V Normal - MiniMax H3 0.6.json', 'First AND last image per scene.'],
  ['Ref2V Basic - MiniMax H3 0.6.json', 'Tagged references — the @hero_face / @storyboard idea.'],
  ['I2V Studio - MiniMax H3 0.6.json', 'Same sampling, plus their experimental timeline interface.'],
  ['Masked AV Extension - Single Clip - MiniMax H3 0.6.json', 'Their protected-latent-prefix continuity.']
] as const

// ComfyUI's Workflows sidebar lists only `user/default/workflows`. The pack's
// examples live in `custom_nodes`, so they never show up there - which is
// exactly how they get missed. The usable ones were copied into a ContextLoop
// folder inside the sidebar's own directory; the Deferred Upscale and
// EXPERIMENTAL graphs were left out, since they need packs this machine does
// not have and would open full of red nodes.
const WORKFLOW_FOLDER = 'ContextLoop'

export function ContextLoopPanel() {
  // Whether the pack actually loaded. Cloning the repo is not enough - ComfyUI
  // registers custom nodes at startup, so without a restart the graphs open
  // with every Chain node red and nothing explains why.
  const [packState, setPackState] = useState<'checking' | 'ready' | 'missing' | 'down'>('checking')
  const [frameKey, setFrameKey] = useState(0)

  async function checkPack() {
    setPackState('checking')
    try {
      const res = await fetch(`${COMFY}/object_info/MiniMaxH3ChainPlan`)
      if (!res.ok) {
        setPackState('missing')
        return
      }
      const body = await res.json()
      setPackState(body && Object.keys(body).length > 0 ? 'ready' : 'missing')
    } catch {
      setPackState('down')
    }
  }

  useEffect(() => {
    checkPack()
  }, [])

  return (
    <div>
      <p>
        ComfyUI, embedded, for trying the <strong>MiniMax H3 Context Loop</strong> pack. This tab is wired
        to nothing else in the app — no movie, no rows, no flows. Its runs are written to{' '}
        <code>output/h3_chains/&lt;run_name&gt;/</code>, away from the movie folders.
      </p>

      {packState === 'checking' && <p className="empty">Checking whether the pack is loaded…</p>}
      {packState === 'ready' && (
        <p className="empty">
          <strong>Pack loaded.</strong> The Chain nodes are registered. Open one from the{' '}
          <strong>Workflows</strong> sidebar, in the <code>{WORKFLOW_FOLDER}</code> folder.
        </p>
      )}
      {packState === 'missing' && (
        <p className="error">
          The pack is installed on disk but <strong>not loaded</strong> — ComfyUI registers custom nodes
          only at startup. Restart it with the <strong>ComfyUI (CORS)</strong> desktop shortcut, then press
          Re-check. Until then its graphs will open with every Chain node red.
        </p>
      )}
      {packState === 'down' && (
        <p className="error">ComfyUI is not answering at {COMFY}. Start it, then press Re-check.</p>
      )}

      <div className="upload-form">
        <button type="button" onClick={checkPack}>
          Re-check
        </button>
        <button type="button" onClick={() => setFrameKey((n) => n + 1)}>
          Reload the view
        </button>
        <button type="button" onClick={() => window.open(COMFY, '_blank', 'noopener')}>
          Open in its own window
        </button>
      </div>

      <details>
        <summary>Which workflow to open, and what to expect</summary>
        <p className="empty">
          In ComfyUI's <strong>Workflows</strong> sidebar, in the <code>{WORKFLOW_FOLDER}</code> folder
          (refresh the view if it is not listed yet):
        </p>
        <ul>
          {WORKFLOWS.map(([file, note]) => (
            <li key={file}>
              <code>{file}</code> — <span className="empty">{note}</span>
            </li>
          ))}
        </ul>
        <p className="empty">
          <strong>Expect to re-pick the model loaders.</strong> Their examples were saved against
          <code> minimax_h3_video_vae_int8_convrot</code> and <code>qwen3vl_32b_minimax_h3_int8_convrot</code>;
          this machine has the <code>fp16</code> and <code>nvfp4_awq</code> variants. Same roles, different
          files — set each loader to the equivalent rather than hunting for the exact filename.
        </p>
        <p className="empty">
          Give the Production Plan a <strong>unique run_name</strong>. Reusing one resumes that run.
        </p>
      </details>

      <iframe key={frameKey} className="comfy-frame" src={COMFY} title="ComfyUI" />
    </div>
  )
}
