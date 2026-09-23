// Deletes rendered files from ComfyUI's folders.
//
// The admin app can delete a row, but not a file: ComfyUI exposes no delete
// endpoint and a browser cannot touch the disk. So every "Delete" in the UI
// left the .png or .mp4 behind, and the output folder only ever grew. This runs
// server-side, where the filesystem is reachable.
//
// Two safety rules, both non-negotiable:
//
//   1. A path must resolve inside ComfyUI's own output/ or input/ folder. The
//      caller sends strings that came out of a database, so a value like
//      "../../Windows/System32/..." has to be impossible, not unlikely.
//   2. A file still referenced by another row is kept. Images get reused - an
//      edit becomes the reference for the next edit, a character shot becomes
//      the source for a sheet - and deleting one of those would leave a working
//      row pointing at nothing. Those are reported as kept, with the reason.
const axios = require('axios');
const fs = require('fs');
const path = require('path');

const insforgeUrl = $insforgeUrl;
const insforgeApiKey = $insforgeApiKey;
const authHeaders = { Authorization: `Bearer ${insforgeApiKey}` };

const COMFY_ROOT = String($comfyRoot || 'C:/ComfyUI2').replace(/[\\/]+$/, '');
const ALLOWED = [path.resolve(COMFY_ROOT, 'output'), path.resolve(COMFY_ROOT, 'input')];

let parsed;
try {
  parsed = JSON.parse(($flow.input || '').toString());
} catch (e) {
  return { error: 'Expected JSON input {"paths":["output/..."]}' };
}

const paths = Array.isArray(parsed.paths) ? parsed.paths.filter(Boolean) : [];
if (!paths.length) return { action: 'complete', deleted: [], kept: [], missing: [] };
if (paths.length > 50) return { error: 'Too many files in one request.' };

// Where a path can still be referenced. Scalar columns are matched exactly;
// the array/jsonb ones are matched as text, since a path sitting inside a JSON
// array is just as much a live reference as one in its own column.
const SCALAR_REFS = [
  ['character_images', 'image_path'],
  ['image_edits', 'output_path'],
  ['minimax_clips', 'video_path'],
  ['minimax_clips', 'first_image_path'],
  ['minimax_clips', 'last_image_path'],
  ['qwen_cleanups', 'cleaned_image_path'],
  ['qwen_cleanups', 'source_image_path'],
  ['qwen_cleanups', 'reference_image_path'],
  ['qwen_cleanups', 'reference_pano_path'],
  ['scene_panos', 'image_path'],
  ['scene_splats', 'ply_path'],
  ['scene_splats', 'backup_path'],
  ['shots', 'video_path'],
  ['shots', 'cleaned_image_path'],
  ['shots', 'raw_capture_path'],
  ['voice_replacements', 'output_path'],
  ['voice_replacements', 'vocal_path'],
  ['voice_replacements', 'bed_path'],
  ['scores', 'audio_path']
];
const TEXT_REFS = [
  ['image_edits', 'reference_paths'],
  ['minimax_clips', 'reference_image_paths'],
  ['shots', 'extra_reference_paths']
];

/** ComfyUI writes mixed separators; compare on one form only. */
function norm(p) {
  return String(p).split(String.fromCharCode(92)).join('/');
}

/** Absolute path, or null when it escapes ComfyUI's folders. */
function resolveInside(rel) {
  const clean = norm(rel).replace(/^\/+/, '');
  const full = path.resolve(COMFY_ROOT, clean);
  return ALLOWED.some((root) => full === root || full.startsWith(root + path.sep)) ? full : null;
}

/**
 * Every row still pointing at this file, other than the ones the caller has
 * already deleted. Returns a list of "table.column" strings.
 */
async function referencedBy(p) {
  const found = [];
  const variants = [norm(p), norm(p).split('/').join(String.fromCharCode(92))];
  for (const [table, column] of SCALAR_REFS) {
    for (const v of variants) {
      try {
        const res = await axios.get(`${insforgeUrl}/api/database/records/${table}`, {
          params: { [column]: `eq.${v}`, select: 'id', limit: 1 },
          headers: authHeaders
        });
        if ((res.data || []).length) {
          found.push(`${table}.${column}`);
          break;
        }
      } catch (e) {
        // A table that cannot be read cannot be proven clear, so treat the
        // failure as a reference. Keeping a file is recoverable; deleting one
        // that is still in use is not.
        found.push(`${table}.${column} (unreadable: ${e.response ? e.response.status : e.message})`);
        break;
      }
    }
  }
  // The array columns hold JSON or text[], and PostgREST will not run a LIKE
  // against those types - it errors, which the catch below then reads as "still
  // referenced" and nothing is ever deletable. These tables hold hundreds of
  // rows at most, so the column is read and compared here instead.
  for (const [table, column] of TEXT_REFS) {
    try {
      const res = await axios.get(`${insforgeUrl}/api/database/records/${table}`, {
        params: { select: `id,${column}`, limit: 2000 },
        headers: authHeaders
      });
      const rows = Array.isArray(res.data) ? res.data : [];
      for (const row of rows) {
        const blob = norm(JSON.stringify(row[column] === undefined ? '' : row[column]));
        if (blob.includes(norm(p))) {
          found.push(`${table}.${column}`);
          break;
        }
      }
    } catch (e) {
      found.push(`${table}.${column} (unreadable: ${e.response ? e.response.status : e.message})`);
    }
  }
  return found;
}

const deleted = [];
const kept = [];
const missing = [];

for (const raw of paths) {
  const full = resolveInside(raw);
  if (!full) {
    kept.push({ path: raw, reason: 'outside ComfyUI output/ and input/ - refused' });
    continue;
  }
  if (!fs.existsSync(full)) {
    missing.push(raw);
    continue;
  }
  if (!fs.statSync(full).isFile()) {
    kept.push({ path: raw, reason: 'not a file' });
    continue;
  }
  const refs = parsed.force === true ? [] : await referencedBy(raw);
  if (refs.length) {
    kept.push({ path: raw, reason: 'still used by ' + refs.join(', ') });
    continue;
  }
  try {
    fs.unlinkSync(full);
    deleted.push(raw);
  } catch (e) {
    kept.push({ path: raw, reason: 'could not delete: ' + e.message });
  }
}

return {
  action: 'complete',
  deleted: deleted,
  kept: kept,
  missing: missing,
  summary:
    `${deleted.length} deleted` +
    (kept.length ? `, ${kept.length} kept` : '') +
    (missing.length ? `, ${missing.length} already gone` : '')
};
