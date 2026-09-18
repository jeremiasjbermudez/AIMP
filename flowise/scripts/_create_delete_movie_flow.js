// Creates (or updates) 15-Delete-Movie: removes a movie and everything that
// belongs to it - database rows, the storage bucket, and the ComfyUI folders
// named after its slug. Dry-runs unless the exact title is sent back as
// confirmation.
//
//   node _create_delete_movie_flow.js               -> creates
//   UPDATE_ID=<id> node _create_delete_movie_flow.js -> updates
const fs = require('fs');
const path = require('path');
const axios = require('axios');

const BASE = 'http://localhost:3010';
const API_KEY = '<REDACTED>';
const INSFORGE_URL = 'http://localhost:7130';
const INSFORGE_API_KEY = '<INSFORGE_API_KEY>';
const COMFY_URL = 'http://127.0.0.1:8188';
// JWImageLoadRGB takes absolute paths on the ComfyUI machine, so the flow needs
// to know where that install lives. Same constant 6-GS-Cleaner hardcodes.
const COMFY_ROOT = 'C:/ComfyUI2/';

const NODE_SOURCE = fs.readFileSync(path.join(__dirname, '_delete_movie_node.js'), 'utf8');

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
      id, label: 'Delete Movie', version: 1.1, name: 'customFunctionAgentflow', type: 'CustomFunction',
      color: '#E4B7FF', baseClasses: ['CustomFunction'], category: 'Agent Flows',
      description: 'Execute custom function', inputParams: FN_INPUTS, inputAnchors: [],
      inputs: {
        customFunctionInputVariables: [
          { variableName: 'insforgeUrl', variableValue: INSFORGE_URL },
          { variableName: 'insforgeApiKey', variableValue: INSFORGE_API_KEY },
          { variableName: 'comfyRoot', variableValue: COMFY_ROOT }
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
        { name: '15-Delete-Movie', type: 'AGENTFLOW', flowData, deployed: true },
        { headers }
      );
      console.log('CREATED', res.data.id);
    }
  } catch (e) {
    console.log('FAILED', e.response ? JSON.stringify(e.response.data).slice(0, 1500) : e.message);
  }
})();
