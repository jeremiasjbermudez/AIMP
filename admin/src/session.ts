/**
 * Keeping the admin session alive.
 *
 * The access token lives 15 minutes. Signing in once at mount - which is what
 * this app did - means every upload starts failing about a quarter of an hour
 * after you open the tab, with "You do not have permission to write ... in
 * bucket movie-x". The message names the bucket, so it reads as a permissions
 * problem with that one movie. It is not: the token has simply expired.
 *
 * Reads hide the problem for a while. `movies`, `scenes` and most SELECT
 * policies allow `anon`, so browsing keeps working perfectly while writes are
 * already dead. Storage RLS is authenticated-only (see migration
 * fix-storage-rls-use-authenticated), so an upload is usually the first thing
 * that visibly breaks.
 *
 * Two layers, because a timer alone is not enough: browsers throttle timers in
 * background tabs and stop them while the machine sleeps, so the one moment you
 * most need a fresh token - returning to a tab left open over lunch - is
 * exactly when the interval did not fire.
 */
import { insforge } from './insforge'

const EMAIL = import.meta.env.VITE_ADMIN_EMAIL
const PASSWORD = import.meta.env.VITE_ADMIN_PASSWORD

/** Refresh this far ahead of expiry, and treat a token inside it as stale. */
const MARGIN_MS = 3 * 60 * 1000
const CHECK_MS = 60 * 1000
/** Only used if the token carries no readable `exp`. Deliberately short. */
const ASSUMED_LIFETIME_MS = 10 * 60 * 1000

/**
 * When the current token dies. Tracked here because the SDK's `Auth` exposes
 * no public session getter - `getSession` lives on the internal token manager.
 */
let expiresAt = 0

function readExp(token: unknown): number {
  if (typeof token !== 'string') return Date.now() + ASSUMED_LIFETIME_MS
  try {
    const part = token.split('.')[1]
    const json = atob(part.replace(/-/g, '+').replace(/_/g, '/'))
    const exp = JSON.parse(json).exp
    return typeof exp === 'number' ? exp * 1000 : Date.now() + ASSUMED_LIFETIME_MS
  } catch {
    return Date.now() + ASSUMED_LIFETIME_MS
  }
}

/** Sign in from scratch. Returns an error message, or null on success. */
export async function signIn(): Promise<string | null> {
  const { data, error } = await insforge.auth.signInWithPassword({ email: EMAIL, password: PASSWORD })
  if (error) {
    expiresAt = 0
    return error.message
  }
  expiresAt = readExp((data as { accessToken?: unknown } | null)?.accessToken)
  return null
}

/**
 * Make sure the token is good for at least the next few minutes.
 *
 * Call before anything that writes. Refreshes through the httpOnly refresh
 * cookie first and falls back to a full sign-in, because that cookie has its
 * own, longer expiry which can also lapse.
 */
export async function ensureFreshSession(): Promise<void> {
  if (Date.now() < expiresAt - MARGIN_MS) return
  const { data, error } = await insforge.auth.refreshSession()
  if (error) {
    await signIn()
    return
  }
  expiresAt = readExp((data as { accessToken?: unknown } | null)?.accessToken)
}

/**
 * Start the background keeper. Returns a teardown function.
 *
 * The visibility and focus handlers are the important half: they cover the
 * sleep and background-throttle cases the interval cannot.
 */
export function startSessionKeeper(): () => void {
  installStorageGuard()
  const tick = () => {
    ensureFreshSession().catch(() => {
      /* The next tick, or the pre-write check, tries again. */
    })
  }
  const onVisible = () => {
    if (document.visibilityState === 'visible') tick()
  }
  const id = window.setInterval(tick, CHECK_MS)
  document.addEventListener('visibilitychange', onVisible)
  window.addEventListener('focus', onVisible)
  return () => {
    window.clearInterval(id)
    document.removeEventListener('visibilitychange', onVisible)
    window.removeEventListener('focus', onVisible)
  }
}

/**
 * Refresh the token before *any* storage call, wherever it is made from.
 *
 * There are a dozen direct `insforge.storage.from(...)` call sites across the
 * panels - uploads, downloads and removes - and adding a refresh to each one
 * by hand means the next one written will miss it. Storage RLS is
 * authenticated-only for reads as well as writes, so a stale token does not
 * just block uploads: it blanks out character photos and reference thumbnails
 * too, which is far less obviously an auth problem.
 *
 * Idempotent, so calling it more than once is harmless.
 */
let guarded = false
export function installStorageGuard(): void {
  if (guarded) return
  guarded = true
  const storage = insforge.storage as unknown as { from: (b: string) => object }
  const original = storage.from.bind(storage)
  storage.from = (bucket: string) =>
    new Proxy(original(bucket), {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver)
        if (typeof value !== 'function') return value
        return async (...args: unknown[]) => {
          await ensureFreshSession()
          // apply against the target so the method keeps its own `this`.
          return (value as (...a: unknown[]) => unknown).apply(target, args)
        }
      }
    })
}
