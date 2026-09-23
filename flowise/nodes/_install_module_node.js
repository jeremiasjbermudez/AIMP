// Install and list modules from the app.
//
// The installers are PowerShell, which a browser cannot run, so this flow runs
// them. That is the same shape as the camera tool and the shot breakdown: the
// browser asks, a flow does the work on the machine.
//
// WHAT THIS DELIBERATELY IS NOT: a way to run commands. The only thing it takes
// from the caller is a module NAME, and that name has to appear in
// modules.json before anything is spawned. Nothing from the request reaches a
// shell as text. Anyone who can reach this flow can already reach Flowise,
// which runs whatever it likes - but a flow that passed a caller's string to a
// shell would be a hole worth having on record, so it does not.
//
// Input:  {"action":"list"}
//         {"action":"install","module":"screenplay"}
//         {"action":"uninstall","module":"colour","dropTables":false}
// Output: {action, modules:[...], log}
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const axios = require('axios');

const insforgeUrl = $insforgeUrl;
const insforgeApiKey = $insforgeApiKey;
// Where the installer lives. Set at install time; without it this flow can
// report what is installed but cannot change anything.
const installRoot = String($installRoot || '').trim();

let parsed;
try {
  parsed = JSON.parse(($flow.input || '{}').toString());
} catch (e) {
  return { error: 'Expected JSON, e.g. {"action":"list"}' };
}
const action = String(parsed.action || 'list').toLowerCase();
if (['list', 'install', 'uninstall'].indexOf(action) < 0) {
  return { error: `action must be list, install or uninstall - got ${action}` };
}

// ---------------------------------------------------------------- the catalogue
if (!installRoot || !fs.existsSync(installRoot)) {
  return {
    error: 'This install does not know where its installer is. Re-run install/core/02-settings.ps1, ' +
      'then re-install the core module so the flow is given the path.'
  };
}
const mapPath = path.join(installRoot, 'modules.json');
if (!fs.existsSync(mapPath)) return { error: `No modules.json under ${installRoot}.` };

let map;
try {
  map = JSON.parse(fs.readFileSync(mapPath, 'utf8'));
} catch (e) {
  return { error: 'modules.json could not be read: ' + e.message };
}
const known = Object.keys(map).filter((k) => k.charAt(0) !== '$');

async function installedNames() {
  try {
    const res = await axios.get(`${insforgeUrl}/api/database/records/installed_modules`, {
      params: { select: 'name,tabs,installed_at' },
      headers: { Authorization: `Bearer ${insforgeApiKey}` }
    });
    return (res.data || []).reduce((acc, r) => {
      acc[r.name] = r;
      return acc;
    }, {});
  } catch (e) {
    return {};
  }
}

/** What the app shows: every module, what it brings, and whether it is here. */
async function catalogue() {
  const installed = await installedNames();
  return known.map((name) => {
    const m = map[name];
    return {
      name,
      title: m.title || name,
      summary: m.summary || '',
      installed: Object.prototype.hasOwnProperty.call(installed, name),
      installedAt: (installed[name] || {}).installed_at || null,
      needs: m.needs || [],
      tabs: (m.panels || []).map((p) => p.tab).filter(Boolean),
      tables: (m.tables || []).length,
      flows: (m.flows || []).length,
      packs: m.packs || [],
      models: m.models || []
    };
  });
}

if (action === 'list') {
  return { action: 'list', modules: await catalogue() };
}

// ---------------------------------------------------------------- run one
const wanted = String(parsed.module || '').trim();
// The whole safety of this flow is this line: a name that is not in the map
// never reaches the shell.
if (known.indexOf(wanted) < 0) {
  return { error: `'${wanted}' is not a module. Known: ${known.join(', ')}` };
}
if (action === 'uninstall' && wanted === 'core') {
  return { error: 'Core cannot be uninstalled.' };
}

const script = path.join(installRoot, action === 'install' ? 'install-module.ps1' : 'uninstall-module.ps1');
if (!fs.existsSync(script)) return { error: `Missing ${script}` };

const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-Module', wanted];
if (action === 'uninstall') {
  // Dropping tables destroys work and is never done on a request from a
  // browser. Removing the tabs is reversible; removing the data is not.
  args.push('-Confirm:$false');
}

const run = await new Promise((resolve) => {
  // No shell: arguments are passed as an array, so nothing is re-parsed.
  // Windows PowerShell on Windows; PowerShell 7 (pwsh) on macOS and Linux.
  // path.sep rather than process.platform: the Flowise sandbox has no process.
  const shell = path.sep === '\\' ? 'powershell.exe' : 'pwsh';
  const p = spawn(shell, args, { windowsHide: true, cwd: installRoot });
  let out = '';
  let err = '';
  p.stdout.on('data', (d) => (out += d.toString()));
  p.stderr.on('data', (d) => (err += d.toString()));
  p.on('error', (e) => resolve({ code: -1, out, err: String(e && e.message) }));
  p.on('close', (code) => resolve({ code, out, err }));
});

const log = (run.out + (run.err ? '\n' + run.err : '')).trim();
if (run.code !== 0) {
  return {
    action: 'error',
    module: wanted,
    reason: `${action} of '${wanted}' failed.`,
    log: log.slice(-4000),
    modules: await catalogue()
  };
}

return {
  action,
  module: wanted,
  log: log.slice(-4000),
  modules: await catalogue(),
  // The app has to reload to pick up a new tab: its panel list is generated at
  // build time, and the dev server has to see the new files.
  note: action === 'install'
    ? 'Installed. Restart the admin dev server to see any new tabs.'
    : 'Removed. Restart the admin dev server.'
};
