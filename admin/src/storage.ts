// Uploading a file into a movie's bucket. The key convention
// `${prefix}/${Date.now()}-${name}` was repeated inline in five places; this
// makes it one fact.
import { insforge, type Movie } from './insforge'
import { ensureFreshSession, signIn } from './session'

/**
 * What a file input should accept for a picture.
 *
 * Deliberately an allowlist rather than `image/*`. `image/*` matches HEIC, the
 * default format of every iPhone photo - it uploads and stores perfectly, then
 * shows as a blank thumbnail, because no browser decodes HEIC and PIL will not
 * open it either without pillow-heif. The failure looks like a broken upload
 * rather than an unsupported format, which is the worst kind of bug to hit.
 */
export const IMAGE_ACCEPT = 'image/png,image/jpeg,image/webp,image/gif,image/bmp'

/**
 * HEIC can still arrive by drag-and-drop or via the picker's "All files".
 *
 * Judged by CONTENT, not by name. A file called .heic is very often a PNG
 * screenshot that was renamed - one of the character photos already in this
 * project is exactly that - and rejecting it on the extension would refuse a
 * picture that works perfectly. The name is only consulted when the bytes
 * cannot be read at all.
 */
async function unsupportedImage(file: File): Promise<string | null> {
  const reject = `${file.name} is a HEIC photo, which browsers and the renderer cannot read. Convert it to JPEG or PNG first.`
  try {
    const head = new Uint8Array(await file.slice(0, 12).arrayBuffer())
    const box = String.fromCharCode(...head.slice(4, 12))
    // ISO-BMFF: "ftyp" at offset 4, then a brand naming the flavour.
    if (box.startsWith('ftyp') && /hei|mif1|msf1/i.test(box.slice(4))) return reject
    return null
  } catch {
    if (/heic|heif/i.test(file.type) || /\.(heic|heif)$/i.test(file.name)) return reject
    return null
  }
}

export type UploadResult = { key: string; url: string | null } | { error: string }

export async function uploadToMovie(movie: Movie, prefix: string, file: File): Promise<UploadResult> {
  const unsupported = await unsupportedImage(file)
  if (unsupported) return { error: unsupported }

  // Sanitise the filename. A key with %, [ ] or spaces in it cannot round-trip
  // through the storage URL - "[55%]" is not a decodable escape - and the
  // failure surfaces much later as an unreadable file rather than a bad upload.
  const safe = file.name.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/_+/g, '_').slice(-80)
  const key = `${prefix}/${Date.now()}-${safe}`

  // Storage RLS is authenticated-only, so an expired token surfaces here as
  // "You do not have permission to write ... in bucket movie-x" - which names
  // the bucket and reads like a policy problem with that one movie. Refresh
  // first, and re-authenticate once on the way back, because the token can
  // lapse between the check and the upload of a large file.
  await ensureFreshSession()
  let { data, error } = await insforge.storage.from(movie.bucket_name).upload(key, file)
  if (error && /permission|unauthor|forbidden|token/i.test(error.message)) {
    await signIn()
    ;({ data, error } = await insforge.storage.from(movie.bucket_name).upload(key, file))
  }
  if (error || !data) return { error: error?.message ?? 'Upload failed' }
  return { key: data.key, url: (data as { url?: string }).url ?? null }
}
