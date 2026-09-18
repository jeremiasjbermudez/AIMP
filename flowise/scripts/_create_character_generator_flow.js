const axios = require('axios');
const fs = require('fs');
const BASE = 'http://localhost:3010';
const API_KEY = '<REDACTED>';

const fnCode = fs.readFileSync('C:/Flowise/_flow_character_generator_fn.js', 'utf8');

const startNode = {
  id: 'startAgentflow_0',
  position: { x: 100, y: 100 },
  type: 'agentFlow',
  data: {
    id: 'startAgentflow_0',
    label: 'Start',
    version: 1.4,
    name: 'startAgentflow',
    type: 'Start',
    color: '#7EE787',
    hideInput: true,
    baseClasses: ['Start'],
    category: 'Agent Flows',
    description: 'Starting point of the agentflow',
    inputParams: [],
    inputAnchors: [],
    inputs: { startInputType: 'chatInput' },
    outputAnchors: [],
    outputs: {},
    selected: false
  },
  width: 300,
  height: 100,
  selected: false,
  positionAbsolute: { x: 100, y: 100 },
  dragging: false
};

const fnNode = {
  id: 'customFunctionAgentflow_0',
  position: { x: 500, y: 100 },
  type: 'agentFlow',
  data: {
    id: 'customFunctionAgentflow_0',
    label: 'Generate Characters',
    version: 1.1,
    name: 'customFunctionAgentflow',
    type: 'CustomFunction',
    color: '#E4B7FF',
    baseClasses: ['CustomFunction'],
    category: 'Agent Flows',
    description: 'Execute custom function',
    inputParams: [],
    inputAnchors: [],
    inputs: {
      customFunctionInputVariables: [
        { variableName: 'insforgeUrl', variableValue: 'http://localhost:7130' },
        { variableName: 'insforgeApiKey', variableValue: '<INSFORGE_API_KEY>' },
        { variableName: 'openrouterApiKey', variableValue: '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' }
      ],
      customFunctionJavascriptFunction: fnCode
    },
    outputAnchors: [],
    outputs: {},
    selected: false
  },
  width: 300,
  height: 100,
  selected: false,
  positionAbsolute: { x: 500, y: 100 },
  dragging: false
};

const edge = {
  source: 'startAgentflow_0',
  sourceHandle: 'startAgentflow_0-output-startAgentflow',
  target: 'customFunctionAgentflow_0',
  targetHandle: 'customFunctionAgentflow_0-input-customFunction',
  type: 'agentFlow',
  id: 'startAgentflow_0-customFunctionAgentflow_0'
};

const flowData = {
  nodes: [startNode, fnNode],
  edges: [edge],
  viewport: { x: 0, y: 0, zoom: 1 }
};

(async () => {
  try {
    const res = await axios.post(
      BASE + '/api/v1/chatflows',
      {
        name: '3-Character-Generator',
        type: 'AGENTFLOW',
        flowData: JSON.stringify(flowData),
        deployed: true
      },
      { headers: { Authorization: 'Bearer ' + API_KEY } }
    );
    console.log('CREATED', res.data.id);
  } catch (e) {
    console.log('CREATE FAILED', e.response ? JSON.stringify(e.response.data).slice(0, 2000) : e.message);
  }
})();
