/**
 * Turning a palette into an actual grade.
 *
 * The naive way to apply a palette is to hand the source picture to the model
 * as a reference - but that carries the picture's CONTENT as well as its
 * colour, so grading a shot with a Matrix still drags Neo into it. A lookup
 * table carries colour and nothing else.
 *
 * The palette becomes a per-luminance TINT: for each tone, the palette's colour
 * at that brightness, divided by its own brightness so it multiplies instead of
 * replacing. Shadows pick up the palette's shadow colour, highlights its
 * highlight colour, and the subject keeps its own colour relationships.
 * `strength` blends between the original and the fully graded result.
 *
 * The SAME function builds the .cube for ffmpeg and grades the preview in the
 * browser, so what you see and what renders cannot drift apart - which is the
 * usual failure when a look is implemented twice.
 */

export type RGB = [number, number, number]

/** Rec.709 luma. The weights matter: green carries most of the brightness. */
function luma(r: number, g: number, b: number) {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

function hexToRgb(hex: string): RGB {
  const h = hex.replace('#', '')
  return [
    parseInt(h.slice(0, 2), 16) / 255,
    parseInt(h.slice(2, 4), 16) / 255,
    parseInt(h.slice(4, 6), 16) / 255
  ]
}

/** The palette as a ramp, sorted dark to light and sampled at any position. */
function makeRamp(swatches: string[]): RGB[] {
  const stops = swatches.map(hexToRgb).sort((a, b) => luma(...a) - luma(...b))
  if (stops.length === 1) stops.push(stops[0])
  return stops
}

/**
 * How colourful the palette itself is, 0..1, as mean HSV saturation.
 *
 * The tint below carries hue balance and nothing else, because dividing a
 * swatch by its own brightness is exactly what removes brightness AND
 * colourfulness from it. That is correct for hue and useless for everything
 * else: a greyscale palette like Bleach bypass or Monochrome silver reduces to
 * (1,1,1), and multiplying by one is a no-op. Picking those looks appeared to
 * do nothing at all, because it did nothing at all.
 *
 * So the palette's own saturation is measured separately and applied as a
 * single factor. It stays ambient rather than painted: chroma is scaled around
 * each pixel's own luminance, so hues stay where they are and only their
 * intensity moves toward the palette's.
 */
function paletteSaturation(ramp: RGB[]): number {
  let total = 0
  for (const [r, g, b] of ramp) {
    const max = Math.max(r, g, b)
    const min = Math.min(r, g, b)
    total += max > 0.0001 ? (max - min) / max : 0
  }
  return total / ramp.length
}

/**
 * Palette saturation as a multiplier on the image's chroma.
 *
 * 0.30 is roughly the mean saturation of an ordinary photograph, so a palette
 * of about that colourfulness leaves the image alone. Clamped at both ends:
 * a pure greyscale palette must not force a literal monochrome (that is a
 * different look, and destroys skin), and a very saturated one must not tip
 * into cartoon.
 */
function saturationFactor(ramp: RGB[]): number {
  return Math.max(0.15, Math.min(1.5, paletteSaturation(ramp) / 0.3))
}

function sampleRamp(ramp: RGB[], t: number): RGB {
  const x = Math.max(0, Math.min(1, t)) * (ramp.length - 1)
  const i = Math.min(ramp.length - 2, Math.floor(x))
  const f = x - i
  const a = ramp[i]
  const b = ramp[i + 1]
  return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f]
}

/**
 * Grade one colour toward the palette.
 *
 * NOT a gradient map. Replacing each tone's colour with the palette's colour at
 * that luminance is what makes an image look coloured-IN - a posterised
 * colouring book where every mid-grey becomes the same olive, and the subject's
 * own colour relationships are erased.
 *
 * Instead the palette is reduced to a neutral-preserving TINT at each
 * luminance: P(L) divided by its own brightness, so it multiplies rather than
 * replaces. A red jacket stays relatively redder than the wall behind it; the
 * whole frame just drifts toward the palette's colour balance. That is what a
 * grade does and what reads as ambient rather than painted.
 *
 * Exported so the browser preview and the .cube writer share one definition.
 */
export function gradeColor(
  ramp: RGB[],
  r: number,
  g: number,
  b: number,
  strength: number,
  satFactor = saturationFactor(ramp)
): RGB {
  const l = luma(r, g, b)
  const target = sampleRamp(ramp, l)
  const tl = luma(...target)
  // The tint: the palette colour with its brightness divided out, so it carries
  // only colour balance. A neutral palette gives (1,1,1) - which is why the
  // saturation factor below exists.
  const tint: RGB =
    tl > 0.0001 ? [target[0] / tl, target[1] / tl, target[2] / tl] : [1, 1, 1]
  let graded: RGB = [
    Math.min(1, r * tint[0]),
    Math.min(1, g * tint[1]),
    Math.min(1, b * tint[2])
  ]
  // Chroma scaled around the pixel's own luminance: the hue is untouched, only
  // how strongly it reads. This is what makes a greyscale palette actually
  // desaturate and a bold one actually bite.
  const gl = luma(...graded)
  graded = [
    Math.max(0, Math.min(1, gl + (graded[0] - gl) * satFactor)),
    Math.max(0, Math.min(1, gl + (graded[1] - gl) * satFactor)),
    Math.max(0, Math.min(1, gl + (graded[2] - gl) * satFactor))
  ]
  return [
    r + (graded[0] - r) * strength,
    g + (graded[1] - g) * strength,
    b + (graded[2] - b) * strength
  ]
}

/** A .cube 3D LUT, the format ffmpeg's lut3d and Resolve both read. */
export function buildCube(swatches: string[], strength = 0.6, size = 33, title = 'palette'): string {
  const ramp = makeRamp(swatches)
  const sat = saturationFactor(ramp)
  const lines: string[] = [
    `# Generated from a pipeline colour palette`,
    `TITLE "${title.replace(/"/g, "'")}"`,
    `LUT_3D_SIZE ${size}`,
    'DOMAIN_MIN 0.0 0.0 0.0',
    'DOMAIN_MAX 1.0 1.0 1.0',
    ''
  ]
  // .cube iterates red fastest, then green, then blue.
  const d = size - 1
  for (let bi = 0; bi < size; bi++) {
    for (let gi = 0; gi < size; gi++) {
      for (let ri = 0; ri < size; ri++) {
        const [r, g, b] = gradeColor(ramp, ri / d, gi / d, bi / d, strength, sat)
        lines.push(`${r.toFixed(6)} ${g.toFixed(6)} ${b.toFixed(6)}`)
      }
    }
  }
  return lines.join('\n') + '\n'
}

/** Grade an image in the browser and hand back a PNG. Nothing is regenerated. */
export async function gradeImage(src: string, swatches: string[], strength = 0.6): Promise<Blob> {
  const ramp = makeRamp(swatches)
  const sat = saturationFactor(ramp)
  const img = new Image()
  img.crossOrigin = 'anonymous'
  img.src = src
  await new Promise((res, rej) => {
    img.onload = res
    img.onerror = () => rej(new Error('The image could not be loaded.'))
  })
  const c = document.createElement('canvas')
  c.width = img.naturalWidth
  c.height = img.naturalHeight
  const ctx = c.getContext('2d', { willReadFrequently: true })
  if (!ctx) throw new Error('No 2D canvas context.')
  ctx.drawImage(img, 0, 0)
  const data = ctx.getImageData(0, 0, c.width, c.height)
  const px = data.data
  for (let i = 0; i < px.length; i += 4) {
    const [r, g, b] = gradeColor(ramp, px[i] / 255, px[i + 1] / 255, px[i + 2] / 255, strength, sat)
    px[i] = r * 255
    px[i + 1] = g * 255
    px[i + 2] = b * 255
  }
  ctx.putImageData(data, 0, 0)
  return new Promise((res, rej) =>
    c.toBlob((blob) => (blob ? res(blob) : rej(new Error('Could not encode the graded image.'))), 'image/png')
  )
}
