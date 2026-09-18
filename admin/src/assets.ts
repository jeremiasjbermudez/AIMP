import { triggerFlow } from './flowise'
import { insforge } from './insforge'

// Deleting a row used to leave its rendered file on disk forever, so the output
// folder only ever grew. These helpers clean up the file too.
//
// Order matters: delete the DATABASE ROW FIRST, then call this. The flow refuses
// to delete a file that any row still points at, and the row being deleted is
// itself such a row - so calling this first always keeps the file.

export type AssetDeleteResult = {
  deleted: string[]
  kept: { path: string; reason: string }[]
  missing: string[]
  summary: string
}

const EMPTY: AssetDeleteResult = { deleted: [], kept: [], missing: [], summary: '' }

/**
 * Remove files from ComfyUI's output/input folders.
 *
 * Never throws: a failed cleanup must not make a successful row delete look
 * like it failed. Returns what happened so a caller can surface it.
 */
export async function deleteAssetFiles(paths: (string | null | undefined)[]): Promise<AssetDeleteResult> {
  const wanted = paths.filter((p): p is string => !!p && p.trim().length > 0)
  if (wanted.length === 0) return EMPTY
  try {
    const r = await triggerFlow(import.meta.env.VITE_DELETE_ASSET_ID, { paths: wanted })
    if (r.state === 'error') return { ...EMPTY, summary: r.message }
    const parsed = JSON.parse(r.message)
    return {
      deleted: parsed.deleted ?? [],
      kept: parsed.kept ?? [],
      missing: parsed.missing ?? [],
      summary: parsed.summary ?? parsed.error ?? ''
    }
  } catch (e) {
    return { ...EMPTY, summary: e instanceof Error ? e.message : String(e) }
  }
}

/**
 * Remove uploaded files from a movie's InsForge storage bucket.
 *
 * Separate from the above because uploads never reach ComfyUI's folders - they
 * live in object storage, which the browser can delete directly.
 */
export async function deleteStorageObjects(bucket: string, keys: (string | null | undefined)[]) {
  const wanted = keys.filter((k): k is string => !!k && k.trim().length > 0)
  for (const key of wanted) {
    try {
      await insforge.storage.from(bucket).remove(key)
    } catch {
      // Same reasoning as above: the row is already gone, and failing loudly
      // here would misreport that as a failed delete.
    }
  }
}

/** Human-readable note for files that were kept, or '' when everything went. */
export function keptNote(r: AssetDeleteResult): string {
  if (!r.kept.length) return ''
  return (
    `${r.kept.length} file${r.kept.length > 1 ? 's' : ''} kept on disk — ` +
    r.kept.map((k) => `${k.path.split('/').pop()} (${k.reason})`).join('; ')
  )
}
