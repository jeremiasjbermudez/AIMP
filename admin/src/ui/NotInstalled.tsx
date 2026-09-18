/**
 * A control whose module is not installed.
 *
 * Deliberately not hidden. A button that disappears leaves someone hunting for
 * a feature they read about; one that is visibly inert and says what it needs
 * answers the question on the spot.
 */
import { MODULE_TITLES, installCommand } from '../modules'

export function NotInstalled({
  module,
  feature,
  inline
}: {
  /** The module that provides this, e.g. 'colour'. */
  module: string
  /** What the button would have done, in the words on the button. */
  feature: string
  /** Sit in a row of buttons rather than on its own line. */
  inline?: boolean
}) {
  const title = MODULE_TITLES[module] ?? module
  return (
    <span className={inline ? 'not-installed is-inline' : 'not-installed'}>
      <button type="button" disabled title={`${feature} needs the ${title} module. Install it with ${installCommand(module)}`}>
        {feature}
      </button>
      <span className="empty">
        needs the <strong>{title}</strong> module — <code>{installCommand(module)}</code>
      </span>
    </span>
  )
}
