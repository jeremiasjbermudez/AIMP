/**
 * Deploy one InsForge edge function from a file.
 *
 * Edge functions are Deno code InsForge stores in its own database and runs in
 * its own container. They are not Postgres functions, so a schema dump never
 * carried them - which is how a clean install ended up unable to create a
 * project at all: the button calls the `create-movie` function, and nothing had
 * ever deployed it.
 *
 * Deploys through the InsForge API when it accepts it, and falls back to
 * writing the row directly, because the API route has moved between versions
 * and the table has not.
 *
 * Usage:
 *   node deploy-function.js --slug create-movie --file ../functions/create-movie/index.ts
 *                           [--name "Create movie"] [--description "..."]
 *
 * Environment: INSFORGE_URL, INSFORGE_API_KEY, and for the fallback
 * PG_CONTAINER and PG_DB.
 */
const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')

function arg(name, fallback) {
  const i = process.argv.indexOf('--' + name)
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}

const SLUG = arg('slug')
const FILE = arg('file')
const NAME = arg('name', SLUG)
const DESCRIPTION = arg('description', '')

if (!SLUG || !FILE) {
  console.error('need --slug and --file')
  process.exit(2)
}
const code = fs.readFileSync(path.resolve(FILE), 'utf8')

async function viaApi() {
  const base = (process.env.INSFORGE_URL || '').replace(/\/$/, '')
  const key = process.env.INSFORGE_API_KEY
  if (!base || !key) return false
  const headers = { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }
  const payload = { slug: SLUG, name: NAME, description: DESCRIPTION, code, status: 'active' }

  // The route has changed name between InsForge versions; try the ones that
  // have existed rather than pinning to one and failing on the others.
  for (const route of ['/api/functions', '/api/edge-functions', '/api/functions/deploy']) {
    for (const method of ['POST', 'PUT']) {
      try {
        const res = await fetch(base + route, { method, headers, body: JSON.stringify(payload) })
        if (res.ok) {
          console.log(`deployed ${SLUG} via ${method} ${route}`)
          return true
        }
        // 409 means it is already there, which is success for our purposes:
        // fall through to the update below rather than treating it as failure.
        if (res.status === 409) {
          const upd = await fetch(`${base}${route}/${SLUG}`, { method: 'PUT', headers, body: JSON.stringify(payload) })
          if (upd.ok) {
            console.log(`updated ${SLUG} via PUT ${route}/${SLUG}`)
            return true
          }
        }
      } catch (e) {
        // try the next shape
      }
    }
  }
  return false
}

/**
 * Write the row ourselves.
 *
 * Less polite than the API but it is the same table the API writes, and it is
 * what keeps this working when the route has moved again.
 */
function viaDatabase() {
  const container = process.env.PG_CONTAINER
  const db = process.env.PG_DB || 'insforge'
  if (!container) {
    console.error('no PG_CONTAINER set, so the database fallback cannot run')
    return false
  }
  // Through psql's stdin with a dollar-quoted literal, so the code's own
  // quotes and newlines need no escaping.
  const tag = 'fn_' + Math.random().toString(36).slice(2, 8)
  const sql = `
INSERT INTO functions.definitions (slug, name, description, code, status, deployed_at)
VALUES ('${SLUG}', '${NAME.replace(/'/g, "''")}', '${DESCRIPTION.replace(/'/g, "''")}',
        $${tag}$${code}$${tag}$, 'active', now())
ON CONFLICT (slug) DO UPDATE
   SET code = EXCLUDED.code, name = EXCLUDED.name, description = EXCLUDED.description,
       status = 'active', deployed_at = now();
`
  try {
    execFileSync('docker', ['exec', '-i', container, 'psql', '-U', 'postgres', '-d', db,
                            '-v', 'ON_ERROR_STOP=1', '-q'], { input: sql, stdio: ['pipe', 'inherit', 'inherit'] })
    console.log(`deployed ${SLUG} straight into functions.definitions`)
    return true
  } catch (e) {
    console.error(`could not write ${SLUG} to the database: ${e.message}`)
    return false
  }
}

;(async () => {
  if (await viaApi()) return
  console.log(`the API did not accept ${SLUG}; writing the row directly`)
  if (!viaDatabase()) process.exit(1)
})()
