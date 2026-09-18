const axios = require('axios');
const BASE = 'http://localhost:3010';
const API_KEY = '<REDACTED>';
const INSFORGE_URL = 'http://localhost:7130';
const INSFORGE_API_KEY = '<INSFORGE_API_KEY>';

const CHARACTER_GENERATOR_ID = '0e72b75a-ad63-4505-81c4-9d1f82f8d4a4';
const PANORAMIC_GENERATOR_ID = '3a462ae3-e268-4ebd-a357-d2235739b6cb';
const WORLD_BUILDER_ID = '1b313782-0a77-40ac-9e8d-1d4df3eaf708';

// Recovered verbatim from the original orchestrator's execution history
// (agentflowId 05901149-0c44-4128-9e1d-e96ced72b182, execution
// e56101f2-1c68-4267-8e25-0666068859e0). Truncated deliberately at
// World-Builder - everything the original orchestrator ran after that
// (Shot-List-Generator, Camera Placement, Image Cleanup, Places Everyone,
// Inpaint Frame, Generate Shot) belonged to the abandoned fully-automated
// camera/shot pipeline; that's now a manual, human-in-the-loop process
// (ShotsPanel -> 6-GS-Cleaner -> 7-MiniMax-Clip-Generator) and is
// intentionally NOT reintroduced here.
const nodeResolveScope = `const rawInput = ($flow.input || '').trim();
// --force forces all three downstream stages; --force-characters / --force-pano /
// --force-world force just that one. Stripped out before the scope regex match
// below (which requires the whole remaining string to be a bare A/S/B token).
const forceAll = /--force\\b(?!-)/i.test(rawInput);
const forceCharacters = forceAll || /--force-characters\\b/i.test(rawInput);
const forcePano = forceAll || /--force-pano\\b/i.test(rawInput);
const forceWorld = forceAll || /--force-world\\b/i.test(rawInput);
const scopeInput = rawInput.replace(/--force(-\\w+)?\\b/gi, '').trim();
const scopeMatch = /^A(\\d+)(?:S(\\d+)(?:B(\\d+))?)?$/i.exec(scopeInput);
if (!scopeMatch) {
  return { error: \`Could not parse scope "\${scopeInput}". Expected A<act>, A<act>S<scene>, or A<act>S<scene>B<beat> - e.g. A1, A1S2, A1S2B4.\`, characterNames: [] };
}
const scope = {
  act: parseInt(scopeMatch[1], 10),
  scene: scopeMatch[2] ? parseInt(scopeMatch[2], 10) : null,
  beat: scopeMatch[3] ? parseInt(scopeMatch[3], 10) : null
};

const axios = require('axios');
const authHeaders = { Authorization: \`Bearer \${$insforgeApiKey}\` };

// Which movie this runs against is never hardcoded - same dynamic lookup as
// 1-Beat-Generator, follows whatever is currently selected in the
// pipeline-admin app.
const activeRes = await axios.get(\`\${$insforgeUrl}/api/database/records/movies\`, {
  params: { is_active: 'eq.true', select: 'id,title' },
  headers: authHeaders
});
const activeMovies = activeRes.data || [];
if (activeMovies.length === 0) {
  return { error: 'No active movie set. Select one in the pipeline-admin app first.', characterNames: [] };
}
if (activeMovies.length > 1) {
  return { error: \`Found \${activeMovies.length} active movies - this should be impossible (unique index should prevent it).\`, characterNames: [] };
}
const movieId = activeMovies[0].id;
const movieTitle = activeMovies[0].title;

const params = {
  movie_id: \`eq.\${movieId}\`,
  act_number: \`eq.\${scope.act}\`,
  select: 'id,beat_code,scene_number,beat_number,characters'
};
if (scope.scene != null) params.scene_number = \`eq.\${scope.scene}\`;
if (scope.beat != null) params.beat_number = \`eq.\${scope.beat}\`;

const beatsRes = await axios.get(\`\${$insforgeUrl}/api/database/records/beats\`, {
  params,
  headers: authHeaders
});
const beats = beatsRes.data || [];

if (beats.length === 0) {
  const label = 'A' + scope.act + (scope.scene != null ? 'S' + scope.scene : '') + (scope.beat != null ? 'B' + scope.beat : '');
  return { error: \`No beats found for scope \${label} in "\${movieTitle}". Run 1-Beat-Generator for this scope first.\`, characterNames: [] };
}

// Unique character names across every matched beat, in first-seen order.
const seen = new Set();
const characterNames = [];
for (const beat of beats) {
  for (const c of beat.characters || []) {
    if (!seen.has(c.name)) {
      seen.add(c.name);
      characterNames.push(c.name);
    }
  }
}

// Unique scene numbers in scope, for the Panoramic-Generator/World-Builder
// fork - a pre-scene beat (scene_number null, e.g. an opening title
// sequence with no heading yet) has no room to generate a pano/splat for,
// so it's excluded.
const seenScenes = new Set();
const sceneScopes = [];
for (const beat of beats) {
  if (beat.scene_number == null) continue;
  if (!seenScenes.has(beat.scene_number)) {
    seenScenes.add(beat.scene_number);
    sceneScopes.push('A' + scope.act + 'S' + beat.scene_number);
  }
}

return {
  scope,
  movieId,
  movieTitle,
  beatCount: beats.length,
  beatCodes: beats.map((b) => b.beat_code),
  characterNames,
  sceneScopes,
  force: { characters: forceCharacters, pano: forcePano, world: forceWorld }
};
`;

const nodeExtractCharacters = `// The Iteration node needs iterationInput to be a plain array by itself -
// CustomFunction output always nests everything under one "content" string,
// so this small node exists just to unwrap that down to the array Iteration
// actually needs. On error, iterate zero times (a safe no-op) rather than
// guess - the full error/context is still visible on the previous node's
// own output in the execution trace. Appends --force per name when
// --force-characters (or bare --force) was passed to the orchestrator -
// 3-Character-Generator understands that flag on its own input.
const previous = JSON.parse($previousOutput);
if (previous.error) return [];
const suffix = previous.force && previous.force.characters ? ' --force' : '';
return previous.characterNames.map((n) => n + suffix);
`;

const nodeExtractScenesPano = `// Same unwrap-for-Iteration purpose as Extract Character List. Appends
// --force per scene when --force-pano (or bare --force) was passed -
// 4-Panoramic-Generator already understands that flag on its own input.
const previous = JSON.parse($previousOutput);
if (previous.error) return [];
const suffix = previous.force && previous.force.pano ? ' --force' : '';
return previous.sceneScopes.map((s) => s + suffix);
`;

const nodeExtractScenesWorld = `// Same purpose as Extract Scene List (Pano), but for World-Builder - kept
// as a SEPARATE node (not shared) because --force-pano and --force-world
// are independent controls, so the two consumers need independently
// force-suffixed arrays even though they start from the same scene list.
const previous = JSON.parse($previousOutput);
if (previous.error) return [];
const suffix = previous.force && previous.force.world ? ' --force' : '';
return previous.sceneScopes.map((s) => s + suffix);
`;

function fnNode(id, label, x, y, code, inputVariables, inputParams) {
  return {
    id, position: { x, y }, type: 'agentFlow',
    data: {
      id, label, version: 1.1, name: 'customFunctionAgentflow', type: 'CustomFunction',
      color: '#E4B7FF', baseClasses: ['CustomFunction'], category: 'Agent Flows',
      description: 'Execute custom function', inputParams, inputAnchors: [],
      inputs: { customFunctionInputVariables: inputVariables, customFunctionJavascriptFunction: code },
      outputAnchors: [], outputs: {}, selected: false
    },
    width: 300, height: 100, selected: false, positionAbsolute: { x, y }, dragging: false
  };
}

function iterationNode(id, label, x, y, iterationInputRef) {
  return {
    id, position: { x, y }, type: 'agentFlow',
    data: {
      id, label, version: 1, name: 'iterationAgentflow', type: 'Iteration',
      color: '#9C89B8', baseClasses: ['Iteration'], category: 'Agent Flows',
      description: 'Execute the nodes within the iteration block through N iterations',
      inputParams: ITERATION_INPUTS, inputAnchors: [],
      inputs: { iterationInput: iterationInputRef },
      outputAnchors: [], outputs: {}, selected: false
    },
    width: 400, height: 220, selected: false, positionAbsolute: { x, y }, dragging: false
  };
}

function executeFlowChildNode(id, label, parentId, x, y, targetFlowId) {
  return {
    id, position: { x, y }, type: 'agentFlow', parentNode: parentId, extent: 'parent',
    data: {
      id, label, version: 1.2, name: 'executeFlowAgentflow', type: 'ExecuteFlow',
      color: '#a3b18a', baseClasses: ['ExecuteFlow'], category: 'Agent Flows',
      description: 'Execute another flow', inputParams: EXECUTE_FLOW_INPUTS, inputAnchors: [],
      inputs: {
        executeFlowSelectedFlow: targetFlowId,
        executeFlowInput: '{{ $iteration }}',
        executeFlowReturnResponseAs: 'userMessage'
      },
      outputAnchors: [], outputs: {}, selected: false
    },
    width: 300, height: 100, selected: false, positionAbsolute: { x, y }, dragging: false
  };
}

function edge(source, target, sourceType, targetType) {
  return {
    source, sourceHandle: source + '-output-' + sourceType,
    target, targetHandle: target + '-input-' + targetType,
    type: 'agentFlow', id: source + '-' + target
  };
}

let ITERATION_INPUTS;
let EXECUTE_FLOW_INPUTS;

(async () => {
  const fnSchema = await axios.get(BASE + '/api/v1/nodes/customFunctionAgentflow', { headers: { Authorization: 'Bearer ' + API_KEY } });
  const FN_INPUTS = fnSchema.data.inputs;
  const startSchema = await axios.get(BASE + '/api/v1/nodes/startAgentflow', { headers: { Authorization: 'Bearer ' + API_KEY } });
  const iterSchema = await axios.get(BASE + '/api/v1/nodes/iterationAgentflow', { headers: { Authorization: 'Bearer ' + API_KEY } });
  const execSchema = await axios.get(BASE + '/api/v1/nodes/executeFlowAgentflow', { headers: { Authorization: 'Bearer ' + API_KEY } });
  ITERATION_INPUTS = iterSchema.data.inputs;
  EXECUTE_FLOW_INPUTS = execSchema.data.inputs;

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

  const resolveNode = fnNode('customFunctionAgentflow_0', 'Resolve Scope & Characters', 300, 0, nodeResolveScope, [
    { variableName: 'insforgeUrl', variableValue: INSFORGE_URL },
    { variableName: 'insforgeApiKey', variableValue: INSFORGE_API_KEY }
  ], FN_INPUTS);

  const extractCharNode = fnNode('customFunctionAgentflow_1', 'Extract Character List', 700, 0, nodeExtractCharacters, [
    { variableName: 'previousOutput', variableValue: '{{ customFunctionAgentflow_0.output.content }}' }
  ], FN_INPUTS);

  const extractScenePanoNode = fnNode('customFunctionAgentflow_2', 'Extract Scene List (Pano)', 1100, 0, nodeExtractScenesPano, [
    { variableName: 'previousOutput', variableValue: '{{ customFunctionAgentflow_0.output.content }}' }
  ], FN_INPUTS);

  const extractSceneWorldNode = fnNode('customFunctionAgentflow_3', 'Extract Scene List (World)', 1100, 220, nodeExtractScenesWorld, [
    { variableName: 'previousOutput', variableValue: '{{ customFunctionAgentflow_0.output.content }}' }
  ], FN_INPUTS);

  const iterChar = iterationNode('iterationAgentflow_0', 'For Each Character', 1500, 0, '{{ customFunctionAgentflow_1.output.content }}');
  const execChar = executeFlowChildNode('executeFlowAgentflow_0', 'Trigger Character-Generator', 'iterationAgentflow_0', 50, 80, CHARACTER_GENERATOR_ID);

  const iterPano = iterationNode('iterationAgentflow_1', 'For Each Scene: Pano', 1950, 0, '{{ customFunctionAgentflow_2.output.content }}');
  const execPano = executeFlowChildNode('executeFlowAgentflow_1', 'Trigger Panoramic-Generator', 'iterationAgentflow_1', 50, 80, PANORAMIC_GENERATOR_ID);

  const iterWorld = iterationNode('iterationAgentflow_2', 'For Each Scene: World Builder', 2400, 0, '{{ customFunctionAgentflow_3.output.content }}');
  const execWorld = executeFlowChildNode('executeFlowAgentflow_2', 'Trigger World Builder', 'iterationAgentflow_2', 50, 80, WORLD_BUILDER_ID);

  const flowData = {
    nodes: [
      startNode, resolveNode, extractCharNode, extractScenePanoNode, extractSceneWorldNode,
      iterChar, execChar,
      iterPano, execPano,
      iterWorld, execWorld
    ],
    edges: [
      edge('startAgentflow_0', 'customFunctionAgentflow_0', 'startAgentflow', 'customFunction'),
      edge('customFunctionAgentflow_0', 'customFunctionAgentflow_1', 'customFunction', 'customFunction'),
      edge('customFunctionAgentflow_1', 'customFunctionAgentflow_2', 'customFunction', 'customFunction'),
      edge('customFunctionAgentflow_2', 'customFunctionAgentflow_3', 'customFunction', 'customFunction'),
      edge('customFunctionAgentflow_3', 'iterationAgentflow_0', 'customFunction', 'iteration'),
      edge('iterationAgentflow_0', 'iterationAgentflow_1', 'iteration', 'iteration'),
      edge('iterationAgentflow_1', 'iterationAgentflow_2', 'iteration', 'iteration')
    ],
    viewport: { x: 0, y: 0, zoom: 0.4 }
  };

  const EXISTING_ID = process.env.UPDATE_ID;
  try {
    if (EXISTING_ID) {
      const res = await axios.put(
        BASE + '/api/v1/chatflows/' + EXISTING_ID,
        { flowData: JSON.stringify(flowData) },
        { headers: { Authorization: 'Bearer ' + API_KEY } }
      );
      console.log('UPDATED', res.data.id);
    } else {
      const res = await axios.post(
        BASE + '/api/v1/chatflows',
        { name: '2-Trigger-Orchestration', type: 'AGENTFLOW', flowData: JSON.stringify(flowData), deployed: true },
        { headers: { Authorization: 'Bearer ' + API_KEY } }
      );
      console.log('CREATED', res.data.id);
    }
  } catch (e) {
    console.log('CREATE FAILED', e.response ? JSON.stringify(e.response.data).slice(0, 3000) : e.message);
  }
})();
