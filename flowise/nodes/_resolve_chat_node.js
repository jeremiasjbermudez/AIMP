// The Resolve chat: qwen drives DaVinci Resolve through a fixed set of verbs.
//
// Two deliberate constraints:
//   - The model never sees or invents a file path. It works in BEAT CODES, and
//     this node resolves those to files. A model inventing a path is the most
//     likely way to produce a confident, wrong result.
//   - Every tool returns the real resulting state (what is in the pool, what is
//     on the timeline), so the model corrects itself instead of drifting from
//     what Resolve actually contains.
const axios = require('axios');
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const insforgeUrl = $insforgeUrl;
const insforgeApiKey = $insforgeApiKey;
// @include llm
// ---------------------------------------------------------------------------
const authHeaders = { Authorization: `Bearer ${insforgeApiKey}` };

const PYTHON = 'C:/Users/Alivai/AppData/Local/Programs/Python/Python313/python.exe';
const WORKER = 'C:/Flowise/resolve_job.py';
const MAX_STEPS = 14;  // discovery costs steps; leave room to look then act

let parsed;
try {
  parsed = JSON.parse(($flow.input || '').toString());
} catch (e) {
  return { error: 'Expected JSON input.' };
}
if (parsed.action !== 'chat') return { error: 'Unknown action.' };
const movieId = parsed.movieId;
if (!movieId) return { error: 'Missing movieId.' };
const history = Array.isArray(parsed.messages) ? parsed.messages : [];

// The slug decides where an export lands. Without it the worker falls back to a
// root-level folder, which puts a movie's render outside the movie.
const movieRes = await axios.get(`${insforgeUrl}/api/database/records/movies`, {
  params: { id: `eq.${movieId}`, select: 'slug' },
  headers: authHeaders
});
const movieSlug = ((movieRes.data || [])[0] || {}).slug || '';

async function worker(payload) {
  const dir = 'C:/Flowise/_resolve_jobs';
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'chat_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8) + '.json');
  fs.writeFileSync(file, JSON.stringify(payload), 'utf8');
  return await new Promise((resolve) => {
    execFile(PYTHON, [WORKER, '@' + file], { cwd: 'C:/Flowise', timeout: 300000, maxBuffer: 10 * 1024 * 1024 },
      (err, stdout, stderr) => {
        const out = (stdout || '').trim();
        try { resolve(JSON.parse(out.split('\n').pop())); }
        catch (e) { resolve({ error: out || (stderr || '').slice(-400) || (err && err.message) || 'no output' }); }
      });
  });
}

// --- the movie's clips, in story order, keyed by beat -----------------------
const clipsRes = await axios.get(`${insforgeUrl}/api/database/records/minimax_clips`, {
  params: { movie_id: `eq.${movieId}`, status: 'eq.complete', select: 'id,mode,video_path,beat_id,length,created_at', order: 'created_at.asc' },
  headers: authHeaders
});
let clips = (clipsRes.data || []).filter((c) => c.video_path);

const beatIds = [...new Set(clips.map((c) => c.beat_id).filter(Boolean))];
const beats = {};
if (beatIds.length) {
  const br = await axios.get(`${insforgeUrl}/api/database/records/beats`, {
    params: { id: `in.(${beatIds.join(',')})`, select: 'id,sequence_index,beat_code,summary' },
    headers: authHeaders
  });
  for (const b of br.data || []) beats[b.id] = b;
}
clips.sort((a, b) => {
  const sa = beats[a.beat_id] ? beats[a.beat_id].sequence_index : Number.MAX_SAFE_INTEGER;
  const sb = beats[b.beat_id] ? beats[b.beat_id].sequence_index : Number.MAX_SAFE_INTEGER;
  return sa !== sb ? sa - sb : String(a.created_at).localeCompare(String(b.created_at));
});

const vr = await axios.get(`${insforgeUrl}/api/database/records/voice_replacements`, {
  params: { movie_id: `eq.${movieId}`, status: 'eq.complete', select: 'clip_id,output_path', order: 'created_at.asc' },
  headers: authHeaders
});
const revoiced = {};
for (const v of vr.data || []) if (v.clip_id && v.output_path) revoiced[v.clip_id] = v.output_path;

// Each clip gets a stable label the model can refer to.
const catalogue = clips.map((c, i) => {
  const b = beats[c.beat_id];
  return {
    label: b && b.beat_code ? b.beat_code : 'clip' + (i + 1),
    id: c.id,
    path: revoiced[c.id] || c.video_path,
    mode: c.mode,
    seconds: Math.round((c.length / 24) * 10) / 10,
    revoiced: !!revoiced[c.id],
    summary: b && b.summary ? String(b.summary).slice(0, 90) : null
  };
});
// Labels repeat when a beat has several takes; make them unique.
const seen = {};
for (const c of catalogue) {
  seen[c.label] = (seen[c.label] || 0) + 1;
  if (seen[c.label] > 1) c.label = c.label + '-' + seen[c.label];
}
const byLabel = {};
for (const c of catalogue) byLabel[c.label.toLowerCase()] = c;

function resolveLabels(list) {
  if (!list || list === 'all' || (Array.isArray(list) && list.length === 1 && String(list[0]).toLowerCase() === 'all')) {
    return { picked: catalogue, unknown: [] };
  }
  const picked = [], unknown = [];
  for (const raw of Array.isArray(list) ? list : [list]) {
    const hit = byLabel[String(raw).toLowerCase()];
    (hit ? picked.push(hit) : unknown.push(raw));
  }
  return { picked, unknown };
}

// --- the verbs the model is allowed to use ----------------------------------
const tools = [
  { type: 'function', function: { name: 'get_state', description: 'What Resolve currently has open: product, project, timelines.', parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'list_projects', description: 'Every Resolve project name.', parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'create_project', description: 'Create a new Resolve project and open it. Never overwrites; a number is appended if the name is taken.', parameters: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] } } },
  { type: 'function', function: { name: 'open_project', description: 'Open an existing Resolve project by name.', parameters: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] } } },
  { type: 'function', function: { name: 'import_clips', description: 'Import clips into the open project by beat label. Use ["all"] for every clip.', parameters: { type: 'object', properties: { beats: { type: 'array', items: { type: 'string' } } }, required: ['beats'] } } },
  { type: 'function', function: { name: 'list_media', description: 'What is in the open project media pool.', parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'list_timelines', description: 'Timelines in the open project and how many clips each holds.', parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'create_timeline', description: 'Build a timeline from clips already imported, in the order given. Use ["all"] for everything, in screenplay order.', parameters: { type: 'object', properties: { name: { type: 'string' }, beats: { type: 'array', items: { type: 'string' } } }, required: ['name'] } } },
  { type: 'function', function: { name: 'export_timeline', description: 'Render/export a timeline to a video file. Handles the whole sequence: selects the timeline, sets format and destination, queues the job and starts it. ALWAYS use this rather than calling render methods yourself.', parameters: { type: 'object', properties: { timeline: { type: 'string', description: 'Timeline name; omit for the one currently open.' }, filename: { type: 'string' }, directory: { type: 'string' }, format: { type: 'string', description: 'mp4 by default' }, codec: { type: 'string', description: 'H264 by default' }, preset: { type: 'string', description: 'A render preset name, instead of format/codec.' }, start: { type: 'boolean', description: 'false to queue without rendering.' } } } } },
  { type: 'function', function: { name: 'render_status', description: 'Whether a render is still running, and the status of a job id.', parameters: { type: 'object', properties: { jobId: { type: 'string' } } } } },
  { type: 'function', function: { name: 'inspect_timeline', description: 'Inspect the open timeline in detail: every clip with its duration and SOURCE resolution, track counts, total length, and how many clips are smaller than the timeline. Use this before giving any opinion about the cut.', parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'rename_clips_to_beats', description: 'Rename the media pool clips from their generated file names to their beat codes (A1S1B1 and so on), which makes the timeline readable. The mapping comes from the pipeline, not from you.', parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'list_settings', description: 'The open project settings and their current values, optionally filtered. USE THIS for anything about resolution, frame rate, super scale, colour science or render setup - it returns the real setting names from the live project.', parameters: { type: 'object', properties: { query: { type: 'string' } } } } },
  { type: 'function', function: { name: 'api_reference', description: 'Search the DaVinci Resolve API reference for method names. Use this BEFORE resolve_api when you are unsure of the exact method, e.g. query "superscale" or "timeline resolution".', parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } } },
  { type: 'function', function: { name: 'resolve_api', description: 'Call ANY method in the Resolve scripting API directly. This is the escape hatch for anything the specific tools do not cover - upscaling, render settings, colour, markers, pages. object is one of Resolve, ProjectManager, MediaStorage, Project, MediaPool, Timeline, Folder, Fusion.', parameters: { type: 'object', properties: { object: { type: 'string' }, method: { type: 'string' }, args: { type: 'array', items: {} }, confirm: { type: 'boolean', description: 'Only set true after the user has explicitly approved a destructive call.' } }, required: ['object', 'method'] } } },
  { type: 'function', function: { name: 'append_clips', description: 'Append clips to an existing timeline.', parameters: { type: 'object', properties: { timeline: { type: 'string' }, beats: { type: 'array', items: { type: 'string' } } }, required: ['timeline', 'beats'] } } }
];

async function callTool(name, args) {
  args = args || {};
  if (name === 'get_state') return await worker({ action: 'status' });
  if (name === 'list_projects') return await worker({ action: 'list_projects' });
  if (name === 'create_project') return await worker({ action: 'create_project', name: args.name });
  if (name === 'open_project') return await worker({ action: 'open_project', name: args.name });
  if (name === 'list_media') return await worker({ action: 'list_media' });
  if (name === 'list_timelines') return await worker({ action: 'list_timelines' });
  if (name === 'import_clips') {
    const { picked, unknown } = resolveLabels(args.beats);
    if (!picked.length) return { error: 'No clips matched.', unknown, availableLabels: catalogue.map((c) => c.label) };
    const r = await worker({ action: 'import_clips', clips: picked.map((c) => ({ path: c.path })) });
    return { ...r, importedLabels: picked.map((c) => c.label), unknown };
  }
  if (name === 'export_timeline') {
    return await worker({
      action: 'export_timeline', timeline: args.timeline, filename: args.filename,
      directory: args.directory, slug: movieSlug, format: args.format, codec: args.codec,
      preset: args.preset, start: args.start !== false
    });
  }
  if (name === 'render_status') return await worker({ action: 'render_status', jobId: args.jobId });
  if (name === 'inspect_timeline') return await worker({ action: 'inspect_timeline' });
  if (name === 'rename_clips_to_beats') {
    // Built here from the pipeline's own data. Letting the model compose this
    // mapping would invite it to invent a beat code for a clip.
    const mapping = {};
    for (const c of catalogue) {
      const file = String(c.path).split('/').pop().split(String.fromCharCode(92)).pop();
      mapping[file] = c.label;
      mapping[file.replace(/\.[^.]+$/, '')] = c.label;
    }
    return await worker({ action: 'rename_clips', mapping });
  }
  if (name === 'list_settings') return await worker({ action: 'list_settings', query: args.query || '' });
  if (name === 'api_reference') return await worker({ action: 'api_reference', query: args.query });
  if (name === 'resolve_api') {
    return await worker({
      action: 'api', object: args.object, method: args.method,
      args: args.args || [], confirm: !!args.confirm
    });
  }
  if (name === 'create_timeline' || name === 'append_clips') {
    const { picked, unknown } = resolveLabels(args.beats);
    if (unknown.length) return { error: 'Unknown labels.', unknown, availableLabels: catalogue.map((c) => c.label) };
    // Media pool names are the file names, so map labels through to those.
    const names = picked.map((c) => String(c.path).split('/').pop().split('\\').pop().replace(/\.[^.]+$/, ''));
    return name === 'create_timeline'
      ? await worker({ action: 'create_timeline', name: args.name, clipNames: names })
      : await worker({ action: 'append_clips', timeline: args.timeline, clipNames: names });
  }
  return { error: 'Unknown tool ' + name };
}

const system = [
  'You operate DaVinci Resolve for a film pipeline. You may ONLY act through the tools provided.',
  '',
  'The clips available for this movie, already in screenplay order:',
  catalogue.map((c) => `  ${c.label}  ${c.seconds}s  ${c.mode}${c.revoiced ? '  [re-voiced]' : ''}${c.summary ? '  - ' + c.summary : ''}`).join('\n'),
  '',
  'Rules:',
  '- Refer to clips ONLY by the labels above. Never invent a file name or path.',
  '- Clips must be imported into a project before they can go on a timeline.',
  '- Read each tool result and correct course if it reports an error - do not claim something worked when the result says otherwise.',
  '- When you are done, reply in one or two plain sentences saying what you actually did.',
  '- You are NOT limited to the named tools. resolve_api reaches the ENTIRE DaVinci Resolve API.',
  '  NEVER reply that you lack a tool for something without first checking list_settings and',
  '  api_reference. "I do not have a tool for that" is almost always wrong and is a failure.',
  '- The named tools are the safe, tested path - prefer them when they fit.',
  '- For anything else (upscaling, render settings, colour, markers, switching pages), you are NOT limited to those tools:',
  '    - For SETTINGS (resolution, frame rate, super scale, colour, render setup): call list_settings',
  '      with a keyword to get the real setting names and current values, then change one with',
  '      resolve_api object "Project", method "SetSetting", args [name, value].',
  '    - For METHODS: call api_reference with a keyword, then resolve_api with what it reports.',
  '  Never guess a name. Look it up first, in ONE call, then act - do not search repeatedly.',
  '- resolve_api REFUSES anything that deletes, removes, closes or overwrites unless confirm is true. When you hit that refusal, stop and ask the user to approve it in plain words. Never set confirm yourself on your own initiative.',
  '- If a request is genuinely impossible through the API, say so - but only after looking.',
  '',
  'Useful to know about this application:',
  '- To export or render, use export_timeline. Never assemble a render out of individual',
  '  resolve_api calls - the sequence is easy to get wrong and fails quietly.',
  '- Trimming clips and adding transitions or audio crossfades are NOT in the Resolve scripting',
  '  API. If asked for those, say plainly that they have to be done by hand in Resolve.',
  '- Upscaling in Resolve is the "superScale" project setting: 0=Auto, 1=none, 2=2x, 3=3x, 4=4x.',
  '  It applies to any clip smaller than the timeline, so it IS how clips get upscaled - there is',
  '  no separate per-clip control. Timeline size is timelineResolutionWidth/Height.',
  '- Render output size is timelineOutputResolutionWidth/Height, which can differ from the timeline.'
].join('\n');

const messages = [{ role: 'system', content: system }, ...history];
const trace = [];

for (let step = 0; step < MAX_STEPS; step++) {
  let res;
  try {
    res = await llmChat( {
      model: ollamaModel, stream: false, think: false,
      options: { temperature: 0.2 },
      tools, messages
    }, { timeout: 300000 });
  } catch (e) {
    const body = (e && e.response && e.response.data) || (e && e.message) || String(e);
    return { error: 'The model call failed: ' + JSON.stringify(body).slice(0, 300), trace };
  }
  const msg = (res.data && res.data.message) || {};
  const calls = msg.tool_calls || [];
  messages.push(msg);

  if (!calls.length) {
    return { reply: (msg.content || '').trim() || '(no reply)', trace, steps: step + 1, model: ollamaModel };
  }
  for (const call of calls) {
    const fn = (call.function || {}).name;
    let args = (call.function || {}).arguments;
    if (typeof args === 'string') { try { args = JSON.parse(args); } catch (e) { args = {}; } }
    const result = await callTool(fn, args);
    trace.push({ tool: fn, args, ok: !result.error, result });
    messages.push({ role: 'tool', content: JSON.stringify(result).slice(0, 4000) });
  }
}
return { reply: 'Stopped after ' + MAX_STEPS + ' steps without finishing. See the tool calls below.', trace, model: ollamaModel };
