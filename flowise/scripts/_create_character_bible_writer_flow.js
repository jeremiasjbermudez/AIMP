// Creates (or updates) 18-Character-Bible-Writer: a conversation that reads the
// movie's screenplay and current cast and rewrites the character bible.
//
//   node _create_character_bible_writer_flow.js                -> creates
//   UPDATE_ID=<id> node _create_character_bible_writer_flow.js -> updates
const fs = require('fs');
const path = require('path');
const axios = require('axios');

const BASE = 'http://localhost:3010';
const API_KEY = '<REDACTED>';
// qwen3.8 reports capabilities ['completion','vision','tools','thinking'] here.
// Deliberately not the local Ollama on 11434 - that box shares its GPU with
// ComfyUI, and a 17.7GB model would fight the renders for VRAM.
const INSFORGE_URL = 'http://localhost:7130';
const INSFORGE_API_KEY = '<INSFORGE_API_KEY>';
const OLLAMA_URL = 'http://<lan-host>:11434';
const OLLAMA_MODEL = 'huihui_ai/Qwen3.8-abliterated:latest';

const NODE_SOURCE = fs.readFileSync(path.join(__dirname, '_character_bible_writer_node.js'), 'utf8');
const SYSTEM_PROMPT = fs.readFileSync(path.join(__dirname, '_character_bible_writer_instruction.md'), 'utf8');

(async () => {
  const headers = { Authorization: 'Bearer ' + API_KEY };
  const fnSchema = await axios.get(BASE + '/api/v1/nodes/customFunctionAgentflow', { headers });
  const FN_INPUTS = fnSchema.data.inputs;
  const startSchema = await axios.get(BASE + '/api/v1/nodes/startAgentflow', { headers });

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

  const id = 'customFunctionAgentflow_0';
  const fnNode = {
    id, position: { x: 300, y: 0 }, type: 'agentFlow',
    data: {
      id, label: 'Write Character Bible', version: 1.1, name: 'customFunctionAgentflow', type: 'CustomFunction',
      color: '#E4B7FF', baseClasses: ['CustomFunction'], category: 'Agent Flows',
      description: 'Execute custom function', inputParams: FN_INPUTS, inputAnchors: [],
      inputs: {
        customFunctionInputVariables: [
          { variableName: 'insforgeUrl', variableValue: INSFORGE_URL },
          { variableName: 'insforgeApiKey', variableValue: INSFORGE_API_KEY },
          { variableName: 'ollamaUrl', variableValue: OLLAMA_URL },
          { variableName: 'ollamaModel', variableValue: OLLAMA_MODEL },
          { variableName: 'systemPrompt', variableValue: SYSTEM_PROMPT }
        ],
        customFunctionJavascriptFunction: NODE_SOURCE
      },
      outputAnchors: [], outputs: {}, selected: false
    },
    width: 300, height: 100, selected: false, positionAbsolute: { x: 300, y: 0 }, dragging: false
  };

  const flowData = JSON.stringify({
    nodes: [startNode, fnNode],
    edges: [
      {
        source: 'startAgentflow_0', sourceHandle: 'startAgentflow_0-output-startAgentflow',
        target: id, targetHandle: id + '-input-customFunction',
        type: 'agentFlow', id: 'startAgentflow_0-' + id
      }
    ],
    viewport: { x: 0, y: 0, zoom: 0.6 }
  });

  try {
    if (process.env.UPDATE_ID) {
      const res = await axios.put(BASE + '/api/v1/chatflows/' + process.env.UPDATE_ID, { flowData }, { headers });
      console.log('UPDATED', res.data.id);
    } else {
      const res = await axios.post(
        BASE + '/api/v1/chatflows',
        { name: '23-Character-Bible-Writer', type: 'AGENTFLOW', flowData, deployed: true },
        { headers }
      );
      console.log('CREATED', res.data.id);
    }
  } catch (e) {
    console.log('FAILED', e.response ? JSON.stringify(e.response.data).slice(0, 1500) : e.message);
  }
})();
