/**
 * The SVG filters the Joker skin paints with.
 *
 * Rendered once, hidden, at the root - a CSS `filter: url(#id)` can only reach
 * a filter that exists in the document, so they live here rather than being
 * repeated per component.
 *
 * Two techniques, doing different jobs:
 *
 * - `paint-edge` warps a shape's outline with fractal noise, turning a straight
 *   CSS border into something torn and hand-made. Cheap, tintable, and it
 *   scales to any size - but the noise is even, so it reads as organic rather
 *   than genuinely painted. Structural edges use it.
 * - `paint-goo` blurs, then crushes the alpha ramp back to hard with a matrix.
 *   Anything near anything else fuses, and a lone drip pulls into a rounded
 *   teardrop, which is how wet paint actually behaves.
 *
 * The loud moments - big splatters, the smear behind the title - use real
 * generated assets instead. Procedural noise cannot do bristle streaks or fine
 * spatter, and pretending otherwise is what made the first pass look flat.
 */
export function PaintFilters() {
  return (
    <svg className="paint-filters" aria-hidden="true" focusable="false">
      <defs>
        <filter id="paint-edge" x="-20%" y="-20%" width="140%" height="140%">
          {/* Low frequency = big lazy wobbles rather than a fuzzy fringe. */}
          <feTurbulence type="fractalNoise" baseFrequency="0.012 0.02" numOctaves="3" seed="7" result="n" />
          <feDisplacementMap in="SourceGraphic" in2="n" scale="9" xChannelSelector="R" yChannelSelector="G" />
        </filter>

        {/* Same idea, harder - for edges that should look torn, not just uneven. */}
        <filter id="paint-edge-rough" x="-25%" y="-25%" width="150%" height="150%">
          <feTurbulence type="fractalNoise" baseFrequency="0.02 0.05" numOctaves="4" seed="19" result="n" />
          <feDisplacementMap in="SourceGraphic" in2="n" scale="16" xChannelSelector="R" yChannelSelector="G" />
        </filter>

        <filter id="paint-goo">
          <feGaussianBlur in="SourceGraphic" stdDeviation="6" result="blur" />
          {/* The 19/-9 row is the contrast crank: it takes the blur's soft alpha
              ramp back to a hard edge, so shapes fuse instead of fading. */}
          <feColorMatrix
            in="blur"
            mode="matrix"
            values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 19 -9"
            result="goo"
          />
          <feComposite in="SourceGraphic" in2="goo" operator="atop" />
        </filter>

        {/* Wet look: a light bevel, so a blob reads as sitting on the surface. */}
        <filter id="paint-wet" x="-20%" y="-20%" width="140%" height="140%">
          <feTurbulence type="fractalNoise" baseFrequency="0.015 0.03" numOctaves="3" seed="3" result="n" />
          <feDisplacementMap in="SourceGraphic" in2="n" scale="7" xChannelSelector="R" yChannelSelector="G" result="warp" />
          <feSpecularLighting in="warp" surfaceScale="3" specularConstant="0.5" specularExponent="18" lightingColor="#ffffff" result="spec">
            <feDistantLight azimuth="230" elevation="58" />
          </feSpecularLighting>
          <feComposite in="spec" in2="warp" operator="in" result="specClip" />
          <feComposite in="warp" in2="specClip" operator="arithmetic" k1="0" k2="1" k3="0.5" k4="0" />
        </filter>
      </defs>
    </svg>
  )
}
