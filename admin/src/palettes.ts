import { insforge, comfyViewUrl, type Movie } from './insforge'

/**
 * Colour palettes: pulling a look off a picture, and storing it.
 *
 * The split matters. The SWATCHES are measured here in the browser by
 * quantising the image's own pixels - exact values. A vision model asked to
 * "give me the hex codes" invents plausible-looking ones instead, which is
 * worse than useless because they look right.
 *
 * The DESCRIPTION comes from the vision model, because that is the half it is
 * genuinely good at, and prose is what actually steers an image generator.
 * "Teal shadows, warm skin, crushed blacks" moves a render; six hex codes do
 * not.
 */

export type Palette = {
  id: string
  movie_id: string | null
  name: string
  swatches: string[]
  description: string | null
  source_path: string | null
  source_key: string | null
  is_builtin: boolean
  created_at: string
}

function hex(r: number, g: number, b: number) {
  return '#' + [r, g, b].map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('')
}

/**
 * Median-cut quantisation down to `count` colours, then sorted dark to light.
 *
 * Median cut rather than k-means: it is deterministic, so the same image always
 * gives the same palette, and it keeps saturated minority colours that k-means
 * tends to average away - a single neon sign in a dark frame is exactly the
 * kind of thing a look is built on.
 */
export function quantise(pixels: Uint8ClampedArray, count = 6): string[] {
  type Box = number[][]
  let boxes: Box[] = [[]]

  // Sub-sample: a 4K frame is 8M pixels and the answer does not change.
  const stride = Math.max(4, Math.floor((pixels.length / 4 / 60000)) * 4) || 4
  for (let i = 0; i < pixels.length; i += 4 * stride) {
    // Fully transparent pixels carry no colour information.
    if (pixels[i + 3] < 128) continue
    boxes[0].push([pixels[i], pixels[i + 1], pixels[i + 2]])
  }
  if (!boxes[0].length) return []

  while (boxes.length < count) {
    // Split whichever box spans the widest single channel - that is where the
    // most visual variety is hiding.
    let target = -1
    let bestSpan = -1
    let bestChan = 0
    boxes.forEach((box, bi) => {
      if (box.length < 2) return
      for (let c = 0; c < 3; c++) {
        let lo = 255
        let hi = 0
        for (const p of box) {
          if (p[c] < lo) lo = p[c]
          if (p[c] > hi) hi = p[c]
        }
        if (hi - lo > bestSpan) {
          bestSpan = hi - lo
          target = bi
          bestChan = c
        }
      }
    })
    if (target < 0) break
    const box = boxes[target].slice().sort((a, b) => a[bestChan] - b[bestChan])
    const mid = Math.floor(box.length / 2)
    boxes.splice(target, 1, box.slice(0, mid), box.slice(mid))
  }

  const out = boxes
    .filter((b) => b.length)
    .map((b) => {
      const n = b.length
      const s = b.reduce((acc, p) => [acc[0] + p[0], acc[1] + p[1], acc[2] + p[2]], [0, 0, 0])
      return [s[0] / n, s[1] / n, s[2] / n] as [number, number, number]
    })
    // Dark to light, so a palette strip reads as a tonal ramp.
    .sort((a, b) => a[0] + a[1] + a[2] - (b[0] + b[1] + b[2]))

  return out.map(([r, g, b]) => hex(r, g, b))
}

/** Load an image (ComfyUI path or blob URL) and pull `count` colours from it. */
export async function paletteFromImage(src: string, count = 6): Promise<string[]> {
  const img = new Image()
  // ComfyUI serves /view with permissive CORS, so the canvas stays untainted.
  img.crossOrigin = 'anonymous'
  img.src = src
  await new Promise((res, rej) => {
    img.onload = res
    img.onerror = () => rej(new Error('The image could not be loaded.'))
  })
  const scale = Math.min(1, 400 / Math.max(img.naturalWidth, img.naturalHeight))
  const c = document.createElement('canvas')
  c.width = Math.max(1, Math.round(img.naturalWidth * scale))
  c.height = Math.max(1, Math.round(img.naturalHeight * scale))
  const ctx = c.getContext('2d', { willReadFrequently: true })
  if (!ctx) throw new Error('No 2D canvas context.')
  ctx.drawImage(img, 0, 0, c.width, c.height)
  return quantise(ctx.getImageData(0, 0, c.width, c.height).data, count)
}

export async function loadPalettes(movieId: string): Promise<Palette[]> {
  // Built-ins have no movie_id and belong to every project, so they are fetched
  // alongside this movie's own.
  const [own, builtin] = await Promise.all([
    insforge.database.from('color_palettes').select('*').eq('movie_id', movieId).order('created_at', { ascending: false }),
    insforge.database.from('color_palettes').select('*').is('movie_id', null).order('name', { ascending: true })
  ])
  return [...((own.data ?? []) as Palette[]), ...((builtin.data ?? []) as Palette[])]
}

export async function savePalette(
  movie: Movie,
  p: { name: string; swatches: string[]; description?: string; sourcePath?: string; sourceKey?: string }
) {
  const { error } = await insforge.database.from('color_palettes').insert([
    {
      movie_id: movie.id,
      name: p.name,
      swatches: p.swatches,
      description: p.description ?? null,
      source_path: p.sourcePath ?? null,
      source_key: p.sourceKey ?? null,
      is_builtin: false
    }
  ])
  return error ? { error: error.message } : {}
}

/** The line appended to a render prompt so the model grades toward the look. */
export function paletteInstruction(p: Palette): string {
  const swatches = p.swatches.join(', ')
  return (
    `Colour grade: ${p.name}. ${p.description ?? ''} ` +
    `Build the image around this palette, darkest to lightest: ${swatches}. ` +
    `Match the grade only - do not change the subject, framing or composition.`
  )
}

/** Preview URL for whatever the palette was pulled from, if anything. */
export function paletteSourceUrl(p: Palette): string | null {
  return p.source_path ? comfyViewUrl(p.source_path) : null
}
