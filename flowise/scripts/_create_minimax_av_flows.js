// Creates (or updates) the two MiniMax AV flows that back the frontend's
// Image-to-Video and Text-to-Video tabs.
//
// Both flows run the SAME node source (_minimax_av_node.js) and differ only in
// the injected `kind` input variable, so the graph can never drift between
// them. `kind` decides mode handling: 't2v' ignores any frames on the clip
// row, 'i2v' requires a first frame and adds a last frame when present.
//
//   node _create_minimax_av_flows.js                       -> creates both
//   UPDATE_I2V_ID=<id> UPDATE_T2V_ID=<id> node ...         -> updates in place
const fs = require('fs');
const path = require('path');
const axios = require('axios');

const BASE = 'http://localhost:3010';
const API_KEY = '<REDACTED>';
const INSFORGE_URL = 'http://localhost:7130';
const INSFORGE_API_KEY = '<INSFORGE_API_KEY>';
const COMFY_URL = 'http://127.0.0.1:8188';

const NODE_SOURCE = fs.readFileSync(path.join(__dirname, '_minimax_av_node.js'), 'utf8');

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

(async () => {
  const headers = { Authorization: 'Bearer ' + API_KEY };
  const fnSchema = await axios.get(BASE + '/api/v1/nodes/customFunctionAgentflow', { headers });
  const FN_INPUTS = fnSchema.data.inputs;
  const startSchema = await axios.get(BASE + '/api/v1/nodes/startAgentflow', { headers });

  function startNode() {
    return {
      id: 'startAgentflow_0', position: { x: 0, y: 0 }, type: 'agentFlow',
      data: {
        id: 'startAgentflow_0', label: 'Start', version: 1.4, name: 'startAgentflow', type: 'Start',
        color: '#7EE787', hideInput: true, baseClasses: ['Start'], category: 'Agent Flows',
        description: 'Starting point of the agentflow', inputParams: startSchema.data.inputs, inputAnchors: [],
        inputs: { startInputType: 'chatInput' }, outputAnchors: [], outputs: {}, selected: false
      },
      width: 300, height: 100, selected: false, positionAbsolute: { x: 0, y: 0 }, dragging: false
    };
  }

  function buildFlowData(kind, label) {
    const n0 = fnNode('customFunctionAgentflow_0', label, 300, NODE_SOURCE, [
      { variableName: 'insforgeUrl', variableValue: INSFORGE_URL },
      { variableName: 'insforgeApiKey', variableValue: INSFORGE_API_KEY },
      { variableName: 'comfyUrl', variableValue: COMFY_URL },
      { variableName: 'kind', variableValue: kind }
    ], FN_INPUTS);
    return {
      nodes: [startNode(), n0],
      edges: [
        {
          source: 'startAgentflow_0', sourceHandle: 'startAgentflow_0-output-startAgentflow',
          target: 'customFunctionAgentflow_0', targetHandle: 'customFunctionAgentflow_0-input-customFunction',
          type: 'agentFlow', id: 'startAgentflow_0-customFunctionAgentflow_0'
        }
      ],
      viewport: { x: 0, y: 0, zoom: 0.6 }
    };
  }

  const flows = [
    { kind: 'i2v', name: '8-MiniMax-Image-To-Video', label: 'Generate MiniMax I2V Clip', updateId: process.env.UPDATE_I2V_ID },
    { kind: 't2v', name: '9-MiniMax-Text-To-Video', label: 'Generate MiniMax T2V Clip', updateId: process.env.UPDATE_T2V_ID }
  ];

  for (const f of flows) {
    const flowData = JSON.stringify(buildFlowData(f.kind, f.label));
    try {
      if (f.updateId) {
        const res = await axios.put(BASE + '/api/v1/chatflows/' + f.updateId, { flowData }, { headers });
        console.log('UPDATED', f.name, res.data.id);
      } else {
        const res = await axios.post(
          BASE + '/api/v1/chatflows',
          { name: f.name, type: 'AGENTFLOW', flowData, deployed: true },
          { headers }
        );
        console.log('CREATED', f.name, res.data.id);
      }
    } catch (e) {
      console.log('FAILED', f.name, e.response ? JSON.stringify(e.response.data).slice(0, 1500) : e.message);
    }
  }
})();
