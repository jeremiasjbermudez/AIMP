const axios = require('axios');
const BASE = 'http://localhost:3010';
const API_KEY = '<REDACTED>';
const INSFORGE_URL = 'http://localhost:7130';
const INSFORGE_API_KEY = '<INSFORGE_API_KEY>';

const node0 = `const scopeInput = ($flow.input || '').trim();
const scopeMatch = /^A(\\d+)(?:S(\\d+)(?:B(\\d+))?)?$/i.exec(scopeInput);
if (!scopeMatch) {
  return { error: \`Could not parse scope "\${scopeInput}". Expected A<act>, A<act>S<scene>, or A<act>S<scene>B<beat> - e.g. A1, A1S2, A1S2B4.\` };
}
const scope = {
  act: parseInt(scopeMatch[1], 10),
  scene: scopeMatch[2] ? parseInt(scopeMatch[2], 10) : null,
  beat: scopeMatch[3] ? parseInt(scopeMatch[3], 10) : null
};

const axios = require('axios');
const insforgeUrl = $insforgeUrl;
const insforgeApiKey = $insforgeApiKey;
const authHeaders = { Authorization: \`Bearer \${insforgeApiKey}\` };

const activeRes = await axios.get(\`\${insforgeUrl}/api/database/records/movies\`, {
  params: { is_active: 'eq.true', select: 'id,bucket_name,title' },
  headers: authHeaders
});
const activeMovies = activeRes.data || [];
if (activeMovies.length === 0) {
  return { error: 'No active movie set. Select one in the pipeline-admin app first.' };
}
if (activeMovies.length > 1) {
  return { error: \`Found \${activeMovies.length} active movies - this should be impossible.\` };
}
const movieId = activeMovies[0].id;
const bucketName = activeMovies[0].bucket_name;
const movieTitle = activeMovies[0].title;

const docsRes = await axios.get(\`\${insforgeUrl}/api/database/records/documents\`, {
  params: { movie_id: \`eq.\${movieId}\`, kind: 'eq.screenplay', select: 'id,storage_key,original_filename' },
  headers: authHeaders
});
const docs = docsRes.data || [];
if (docs.length === 0) {
  return { error: 'No screenplay document found for this movie (kind=screenplay). Upload one first.' };
}
if (docs.length > 1) {
  return { error: \`Found \${docs.length} screenplay documents for this movie - ambiguous which is current.\` };
}
const doc = docs[0];

const key = encodeURIComponent(doc.storage_key);
const strategyRes = await axios.get(\`\${insforgeUrl}/api/storage/buckets/\${bucketName}/download-strategy/objects/\${key}\`, {
  headers: authHeaders
});
const strategy = strategyRes.data;
const fileHeaders = strategy.method === 'direct' ? authHeaders : {};
const fileRes = await axios.get(strategy.url, { headers: fileHeaders, transformResponse: (r) => r });
const screenplayText = fileRes.data;

return {
  scope,
  movieId,
  movieTitle,
  bucketName,
  documentId: doc.id,
  originalFilename: doc.original_filename,
  screenplayLength: screenplayText.length,
  screenplayText
};
`;

const node1 = `const previous = JSON.parse($previousOutput);
if (previous.error) {
  return { error: previous.error };
}
const { scope, screenplayText, movieId, movieTitle, bucketName } = previous;

const lines = screenplayText.split(/\\r\\n|\\r|\\n/);

const sceneHeadingRe = /(\\d+)\\s+(INT|EXT)\\b/;
const actBreakRe = /^END OF ACT\\s+(\\d+)/i;

const rawScenes = [];
let actNumber = 1;
for (let i = 0; i < lines.length; i++) {
  const line = lines[i];
  const actMatch = actBreakRe.exec(line);
  if (actMatch) {
    actNumber = parseInt(actMatch[1], 10) + 1;
    continue;
  }
  const sceneMatch = sceneHeadingRe.exec(line);
  if (sceneMatch) {
    rawScenes.push({
      sceneNumber: parseInt(sceneMatch[1], 10),
      actNumber,
      headingLine: i + 1,
      headingText: line.trim()
    });
  }
}

if (rawScenes.length === 0) {
  return { error: 'No scene headings found in the screenplay text (expected lines like "3 INT. THE CRYPT...").' };
}

const scenes = rawScenes.map((scene, idx) => {
  const nextHeadingLine = idx + 1 < rawScenes.length ? rawScenes[idx + 1].headingLine : lines.length + 1;
  return { ...scene, lineStart: scene.headingLine, lineEnd: nextHeadingLine - 1 };
});

function sliceLines(lineStart, lineEnd) {
  return lines.slice(lineStart - 1, lineEnd).join('\\n');
}

function sliceLinesNumbered(lineStart, lineEnd) {
  const slice = [];
  for (let n = lineStart; n <= lineEnd; n++) {
    slice.push(\`\${n}: \${lines[n - 1]}\`);
  }
  return slice.join('\\n');
}

const preSceneEnd = scenes[0].lineStart - 1;
const hasPreScene = preSceneEnd >= 1 && lines.slice(0, preSceneEnd).some((l) => l.trim().length > 0);

if (scope.beat != null) {
  const axios = require('axios');
  const authHeaders = { Authorization: \`Bearer \${$insforgeApiKey}\` };
  const beatsRes = await axios.get(\`\${$insforgeUrl}/api/database/records/beats\`, {
    params: {
      movie_id: \`eq.\${movieId}\`,
      act_number: \`eq.\${scope.act}\`,
      scene_number: \`eq.\${scope.scene}\`,
      beat_number: \`eq.\${scope.beat}\`,
      select: 'id,line_start,line_end'
    },
    headers: authHeaders
  });
  const existing = (beatsRes.data || [])[0];
  if (!existing) {
    return {
      error: \`Beat A\${scope.act}S\${scope.scene}B\${scope.beat} does not exist yet. Run A\${scope.act}S\${scope.scene} first to generate the scene's beats before regenerating a single one.\`
    };
  }
  return {
    scope,
    movieId,
    movieTitle,
    bucketName,
    lineStart: existing.line_start,
    lineEnd: existing.line_end,
    lineNumberedText: sliceLinesNumbered(existing.line_start, existing.line_end)
  };
}

if (scope.scene != null) {
  const scene = scenes.find((s) => s.sceneNumber === scope.scene);
  if (!scene) {
    return { error: \`Scene \${scope.scene} not found in the screenplay (found scenes: \${scenes.map((s) => s.sceneNumber).join(', ')}).\` };
  }
  return {
    scope,
    movieId,
    movieTitle,
    bucketName,
    scenesInScope: [{ sceneNumber: scene.sceneNumber, actNumber: scene.actNumber, headingText: scene.headingText }],
    lineStart: scene.lineStart,
    lineEnd: scene.lineEnd,
    lineNumberedText: sliceLinesNumbered(scene.lineStart, scene.lineEnd)
  };
}

const actScenes = scenes.filter((s) => s.actNumber === scope.act);
const includesPreScene = scope.act === 1 && hasPreScene;
if (actScenes.length === 0 && !includesPreScene) {
  return { error: \`Act \${scope.act} has no scenes in this screenplay (acts found: \${[...new Set(scenes.map((s) => s.actNumber))].join(', ')}).\` };
}
const lineStart = includesPreScene ? 1 : actScenes[0].lineStart;
const lineEnd = actScenes.length > 0 ? actScenes[actScenes.length - 1].lineEnd : preSceneEnd;
const scenesInScope = [
  ...(includesPreScene ? [{ sceneNumber: null, actNumber: scope.act, headingText: '(pre-scene content, no scene number)' }] : []),
  ...actScenes.map((s) => ({ sceneNumber: s.sceneNumber, actNumber: s.actNumber, headingText: s.headingText }))
];
return {
  scope,
  movieId,
  movieTitle,
  bucketName,
  scenesInScope,
  lineStart,
  lineEnd,
  lineNumberedText: sliceLinesNumbered(lineStart, lineEnd)
};
`;

const node2 = `const beats = JSON.parse($beatsFromLLM);
const extractResult = JSON.parse($extractOutput);
const fetchResult = JSON.parse($fetchOutput);

if (extractResult.error) return { error: extractResult.error };
if (fetchResult.error) return { error: fetchResult.error };

const { scope, movieId } = extractResult;
const screenplayLines = fetchResult.screenplayText.split(/\\r\\n|\\r|\\n/);

function sliceRawText(lineStart, lineEnd) {
  return screenplayLines.slice(lineStart - 1, lineEnd).join('\\n');
}

function hashString(str) {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash + str.charCodeAt(i)) | 0;
  }
  return (hash >>> 0).toString(16);
}

const groups = new Map();
for (const beat of beats) {
  const key = beat.scene_number == null ? 'null' : String(beat.scene_number);
  if (!groups.has(key)) groups.set(key, []);
  groups.get(key).push(beat);
}

const axios = require('axios');
const authHeaders = { Authorization: \`Bearer \${$insforgeApiKey}\`, 'Content-Type': 'application/json' };
const results = [];

for (const [sceneKey, sceneBeats] of groups) {
  const sceneNumber = sceneKey === 'null' ? null : parseInt(sceneKey, 10);
  const groupLineStart = Math.min(...sceneBeats.map((b) => b.line_start));
  const groupLineEnd = Math.max(...sceneBeats.map((b) => b.line_end));
  const currentHash = hashString(\`\${$schemaVersion}::\${sliceRawText(groupLineStart, groupLineEnd)}\`);

  const existingParams = {
    movie_id: \`eq.\${movieId}\`,
    act_number: \`eq.\${scope.act}\`,
    select: 'id,source_hash'
  };
  existingParams.scene_number = sceneNumber == null ? 'is.null' : \`eq.\${sceneNumber}\`;

  const existingRes = await axios.get(\`\${$insforgeUrl}/api/database/records/beats\`, {
    params: existingParams,
    headers: authHeaders
  });
  const existing = existingRes.data || [];
  const existingHash = existing.length > 0 ? existing[0].source_hash : null;

  if (existing.length > 0 && existingHash === currentHash) {
    results.push({ scene: sceneNumber, action: 'skipped', reason: 'source text unchanged', beatCount: existing.length });
    continue;
  }

  if (existing.length > 0) {
    const ids = existing.map((e) => e.id);
    await axios.delete(\`\${$insforgeUrl}/api/database/records/beats\`, {
      params: { id: \`in.(\${ids.join(',')})\` },
      headers: authHeaders
    });
  }

  const rows = sceneBeats.map((beat, idx) => ({
    movie_id: movieId,
    sequence_index: beat.line_start,
    act_number: scope.act,
    scene_number: sceneNumber,
    beat_number: beat.beat_number ?? null,
    line_start: beat.line_start,
    line_end: beat.line_end,
    scene_heading: beat.scene_heading ?? null,
    int_ext: beat.int_ext ?? null,
    location: beat.location ?? null,
    time_of_day: beat.time_of_day ?? null,
    summary: beat.summary,
    raw_text: sliceRawText(beat.line_start, beat.line_end),
    characters: beat.characters ?? [],
    objects: beat.objects ?? [],
    dialogue: beat.dialogue ?? [],
    source_hash: currentHash
  }));

  await axios.post(\`\${$insforgeUrl}/api/database/records/beats\`, rows, {
    headers: { ...authHeaders, Prefer: 'return=minimal' }
  });

  results.push({
    scene: sceneNumber,
    action: existing.length > 0 ? 'regenerated' : 'inserted',
    beatCount: rows.length
  });
}

return { scope, results };
`;

const llmSystemPrompt = "You segment a screenplay excerpt into beats - discrete dramatic units - for a film production pipeline. Every character, object, and line of dialogue you report becomes structured data other automated steps rely on directly, so precision matters more than creative interpretation.\n\nRules:\n- The source text is provided with each line prefixed by its real line number (e.g. \"40: CUT TO...\"). Use those exact numbers for line_start/line_end - do not count or estimate lines yourself.\n- One beat is a continuous stretch of action/dialogue within a SINGLE scene, usually the entire scene unless there is a clear internal shift (e.g. a character exits, a new character enters, and the topic changes). Do not over-split - most scenes are exactly one beat.\n- Beats must be contiguous, non-overlapping, in order, and together cover every line of the source text.\n- A beat never spans more than one scene. If the source text covers multiple scenes, segment each scene separately - beat_number resets to 1 at the start of each new scene.\n- Character and object names: use exactly what is written in the script, but WITHOUT any parenthetical/suffix annotation - e.g. \"CHARACTER\", never \"CHARACTER (CONT'D)\" or \"CHARACTER (V.O.)\". A character's name field must be identical every time that same character appears, anywhere in your output, so it can be matched across beats. If the script marks a line as V.O. (voice-over), O.S. (off-screen), or similar, put that in the character's \"blocking\" field instead (e.g. \"voice-over only, not seen on screen\") - never as part of the name.\n- A character is often introduced with a fuller name than they're referred to by afterward - e.g. action text introducing \"CHARACTER JOSEPH (59, looks 40's, composed...)\" while every later dialogue attribution and action line in the same excerpt just says \"CHARACTER\". When you see this pattern, use the SHORTER form that's used repeatedly across the excerpt for every beat, including the introduction beat itself - never the longer introduction-only form. Check how the character is referred to elsewhere in the full excerpt before deciding their name field, not just the sentence that introduces them.\n- Every parenthetical direction attached to a dialogue line (e.g. \"(beat, then defiantly)\", \"(then, delicately)\") goes ONLY in that line's \"parenthetical\" field. Never write it inline inside \"line\" - the \"line\" field must contain only the words actually spoken, nothing else.\n- Only report what is explicitly present in the text. Never invent characters, objects, or details not present.\n\nscene_number and beat_number - read this carefully, these are REQUIRED for almost every beat, not optional in the usual sense:\n- Every numbered scene heading in the source text literally states its own scene number, e.g. the line \"140: 3 INT. THE CRYPT...\" means scene_number is 3 for every beat that falls inside that scene. Copy it directly from the text you were given - never infer or compute it.\n- beat_number is the count of beats you have produced so far within the CURRENT scene: 1 for the first beat after that scene's heading, 2 for the next beat still in that same scene, and so on - resetting to 1 the moment a new scene heading appears.\n- Every beat that falls after ANY scene heading in the source text MUST include both scene_number and beat_number. Omitting them is WRONG for these beats.\n- The ONLY beats allowed to omit both fields are ones that occur before the very first scene heading in the entire source text (e.g. an opening title sequence/montage with no scene number at all). This is rare - if the source text you were given contains even one numbered scene heading, at most your very first beat can qualify, and only if it starts before that heading's line number. Do not use 0 or any placeholder value for these fields - omit the keys entirely.\n\nOther optional fields (scene_heading, int_ext, location, time_of_day, a character's \"blocking\", an object's \"notes\", a dialogue line's \"parenthetical\") are genuinely cosmetic - omit the key entirely (never null, never empty string) only when that specific piece of information truly is not present in the text for that beat.";

const beatsJsonSchema = "{\n  \"scene_number\": { \"type\": \"nullable_number\", \"description\": \"The screenplay's own scene number this beat belongs to, e.g. 2 for \\\"2 INT. a location...\\\". Omit ONLY for pre-scene content with no scene heading at all (e.g. an opening title sequence/montage before scene 1) - never invent one.\", \"optional\": true },\n  \"beat_number\": { \"type\": \"nullable_number\", \"description\": \"1-indexed position of this beat within its scene (resets to 1 at the start of each new scene). Omit if scene_number is also omitted.\", \"optional\": true },\n  \"line_start\": { \"type\": \"number\", \"description\": \"First line number (from the provided numbered source text) belonging to this beat\" },\n  \"line_end\": { \"type\": \"number\", \"description\": \"Last line number (from the provided numbered source text) belonging to this beat\" },\n  \"scene_heading\": { \"type\": \"nullable_string\", \"description\": \"The verbatim scene slugline this beat belongs to, e.g. \\\"INT. a location - PRESENT DAY (2099)\\\". Omit for pre-scene content.\", \"optional\": true },\n  \"int_ext\": { \"type\": \"nullable_string\", \"description\": \"One of INT, EXT, or INT/EXT, matching the scene heading. Omit for pre-scene content.\", \"optional\": true },\n  \"location\": { \"type\": \"nullable_string\", \"description\": \"Normalized location name, e.g. \\\"a location\\\". Omit for pre-scene content.\", \"optional\": true },\n  \"time_of_day\": { \"type\": \"nullable_string\", \"description\": \"Time of day from the scene heading, e.g. \\\"Present Day (2099)\\\", \\\"Day\\\", \\\"Night\\\", \\\"Continuous\\\". Omit if not specified.\", \"optional\": true },\n  \"summary\": { \"type\": \"string\", \"description\": \"1-3 sentence prose description of what happens in this beat\" },\n  \"characters\": {\n    \"type\": \"array\",\n    \"description\": \"Every character present in this beat, in order of significance\",\n    \"items\": {\n      \"name\": { \"type\": \"string\", \"description\": \"Character name exactly as written in the script (e.g. CHARACTER, not Clem Wellman)\" },\n      \"presence\": { \"type\": \"string\", \"description\": \"Exactly one of: \\\"in_scene\\\" (physically present, visible on screen), \\\"voice_only\\\" (heard but never seen - phone call, V.O., intercom, radio), \\\"off_screen\\\" (present in the location but not shown - e.g. speaking from another room). This determines whether the character needs a visual reference generated, so classify carefully - do not default to in_scene.\" },\n      \"blocking\": { \"type\": \"nullable_string\", \"description\": \"What this character is doing / where positioned during this specific beat, e.g. \\\"seated at his desk, sits back once the interview ends\\\"\", \"optional\": true }\n    }\n  },\n  \"objects\": {\n    \"type\": \"array\",\n    \"description\": \"Physical objects/props present or interacted with in this beat\",\n    \"items\": {\n      \"name\": { \"type\": \"string\", \"description\": \"The object's name\" },\n      \"notes\": { \"type\": \"nullable_string\", \"description\": \"Brief note on how it's used or where it is in this beat\", \"optional\": true }\n    }\n  },\n  \"dialogue\": {\n    \"type\": \"array\",\n    \"description\": \"Every line of dialogue spoken in this beat, in order\",\n    \"items\": {\n      \"character\": { \"type\": \"string\", \"description\": \"Speaking character's name exactly as written in the script\" },\n      \"parenthetical\": { \"type\": \"nullable_string\", \"description\": \"Any parenthetical direction before the line, e.g. \\\"beat, then defiantly\\\". Omit if none.\", \"optional\": true },\n      \"line\": { \"type\": \"string\", \"description\": \"The verbatim dialogue line, without surrounding quote marks\" }\n    }\n  }\n}\n";

function fnNode(id, label, x, code, inputVariables, inputParams) {
  return {
    id, position: { x, y: 0 }, type: 'agentFlow',
    data: {
      id, label, version: 1.1, name: 'customFunctionAgentflow', type: 'CustomFunction',
      color: '#E4B7FF', baseClasses: ['CustomFunction'], category: 'Agent Flows',
      description: 'Execute custom function', inputParams, inputAnchors: [],
      inputs: { customFunctionInputVariables: inputVariables, customFunctionJavascriptFunction: code },
      outputAnchors: [], outputs: {}, selected: false
    },
    width: 300, height: 100, selected: false, positionAbsolute: { x, y: 0 }, dragging: false
  };
}

function edge(source, target, sourceType) {
  return {
    source, sourceHandle: source + '-output-' + sourceType,
    target, targetHandle: target + '-input-customFunction',
    type: 'agentFlow', id: source + '-' + target
  };
}

(async () => {
  const fnSchema = await axios.get(BASE + '/api/v1/nodes/customFunctionAgentflow', { headers: { Authorization: 'Bearer ' + API_KEY } });
  const FN_INPUTS = fnSchema.data.inputs;
  const startSchema = await axios.get(BASE + '/api/v1/nodes/startAgentflow', { headers: { Authorization: 'Bearer ' + API_KEY } });
  const llmSchema = await axios.get(BASE + '/api/v1/nodes/llmAgentflow', { headers: { Authorization: 'Bearer ' + API_KEY } });

  const startNode = {
    id: 'startAgentflow_0', position: { x: 0, y: 0 }, type: 'agentFlow',
    data: {
      id: 'startAgentflow_0', label: 'Start', version: 1.4, name: 'startAgentflow', type: 'Start',
      color: '#7EE787', hideInput: true, baseClasses: ['Start'], category: 'Agent Flows',
      description: 'Starting point of the agentflow', inputParams: startSchema.data.inputs, inputAnchors: [],
      inputs: { startInputType: 'chatInput' }, outputAnchors: [], outputs: {}, selected: false
    },
    width: 300, height: 100, selected: false, positionAbsolute: { x: 0, y: 0 }, dragging: false
  };

  const n0 = fnNode('customFunctionAgentflow_0', 'Fetch Screenplay Scope', 300, node0, [
    { variableName: 'insforgeUrl', variableValue: INSFORGE_URL },
    { variableName: 'insforgeApiKey', variableValue: INSFORGE_API_KEY }
  ], FN_INPUTS);

  const n1 = fnNode('customFunctionAgentflow_1', 'Extract Scope Text', 700, node1, [
    { variableName: 'previousOutput', variableValue: '{{ customFunctionAgentflow_0.output.content }}' },
    { variableName: 'insforgeUrl', variableValue: INSFORGE_URL },
    { variableName: 'insforgeApiKey', variableValue: INSFORGE_API_KEY }
  ], FN_INPUTS);

  const llmNode = {
    id: 'llmAgentflow_0', position: { x: 1100, y: 0 }, type: 'agentFlow',
    data: {
      id: 'llmAgentflow_0', label: 'Segment Into Beats', version: 1.1, name: 'llmAgentflow', type: 'LLM',
      color: '#64B5F6', baseClasses: ['LLM'], category: 'Agent Flows',
      description: 'Large language models to analyze user-provided inputs and generate responses',
      inputParams: llmSchema.data.inputs, inputAnchors: [],
      inputs: {
        llmModel: 'chatOllama',
        llmMessages: [
          { role: 'system', content: llmSystemPrompt },
          { role: 'user', content: 'Segment the following into beats. This is a JSON object; its "lineNumberedText" field is the numbered source text to segment, and its "scope"/"scenesInScope" fields give you context on what act/scene(s) this excerpt covers.\n\n{{ customFunctionAgentflow_1.output.content }}' }
        ],
        llmEnableMemory: false,
        llmMemoryType: 'allMessages',
        llmMemoryWindowSize: '20',
        llmMemoryMaxTokenLimit: '2000',
        llmReturnResponseAs: 'userMessage',
        llmStructuredOutput: [
          { key: 'beats', type: 'jsonArray', jsonSchema: beatsJsonSchema, description: 'Every beat identified in the source text, in order' }
        ],
        llmUpdateState: [],
        llmModelConfig: {
// Ollama runs on the dedicated box, not localhost: the local instance shares
// its GPU with ComfyUI, and loading a 17.7GB model there evicts whatever
// ComfyUI has cached mid-session.
          cache: '', baseUrl: 'http://<lan-host>:11434', modelName: 'huihui_ai/Qwen3.8-abliterated:latest', temperature: 0.3,
          streaming: false, allowImageUploads: false, think: false, jsonMode: false, keepAlive: '0', numCtx: 32768, llmModel: 'chatOllama'
        }
      },
      outputAnchors: [], outputs: {}, selected: false
    },
    width: 300, height: 100, selected: false, positionAbsolute: { x: 1100, y: 0 }, dragging: false
  };

  const n2 = fnNode('customFunctionAgentflow_2', 'Write Beats to InsForge', 1500, node2, [
    { variableName: 'beatsFromLLM', variableValue: '{{ llmAgentflow_0.output.beats }}' },
    { variableName: 'extractOutput', variableValue: '{{ customFunctionAgentflow_1.output.content }}' },
    { variableName: 'fetchOutput', variableValue: '{{ customFunctionAgentflow_0.output.content }}' },
    { variableName: 'insforgeUrl', variableValue: INSFORGE_URL },
    { variableName: 'insforgeApiKey', variableValue: INSFORGE_API_KEY },
    { variableName: 'schemaVersion', variableValue: 'v3' }
  ], FN_INPUTS);

  const flowData = {
    nodes: [startNode, n0, n1, llmNode, n2],
    edges: [
      { source: 'startAgentflow_0', sourceHandle: 'startAgentflow_0-output-startAgentflow', target: 'customFunctionAgentflow_0', targetHandle: 'customFunctionAgentflow_0-input-customFunction', type: 'agentFlow', id: 'startAgentflow_0-customFunctionAgentflow_0' },
      edge('customFunctionAgentflow_0', 'customFunctionAgentflow_1', 'customFunction'),
      edge('customFunctionAgentflow_1', 'llmAgentflow_0', 'customFunction'),
      { source: 'llmAgentflow_0', sourceHandle: 'llmAgentflow_0-output-llmAgentflow', target: 'customFunctionAgentflow_2', targetHandle: 'customFunctionAgentflow_2-input-customFunction', type: 'agentFlow', id: 'llmAgentflow_0-customFunctionAgentflow_2' }
    ],
    viewport: { x: 0, y: 0, zoom: 0.6 }
  };

  try {
    const res = await axios.post(
      BASE + '/api/v1/chatflows',
      { name: '1-Beat-Generator', type: 'AGENTFLOW', flowData: JSON.stringify(flowData), deployed: true },
      { headers: { Authorization: 'Bearer ' + API_KEY } }
    );
    console.log('CREATED', res.data.id);
  } catch (e) {
    console.log('CREATE FAILED', e.response ? JSON.stringify(e.response.data).slice(0, 2000) : e.message);
  }
})();
