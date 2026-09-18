const axios = require('axios'); const fs = require('fs');
const BASE = 'http://localhost:3010';
const H = { Authorization: 'Bearer <REDACTED>' };
(async () => {
  // Clone the Score flow: it already has $ollamaBaseUrl / $ollamaModel wired
  // alongside the InsForge variables, which the agent needs.
  const src = await axios.get(BASE + '/api/v1/chatflows/78461e2b-18c2-4986-8198-fd04e4251ff2', { headers: H });
  const fd = JSON.parse(src.data.flowData);
  const node = fd.nodes.find((n) => n.data.inputs && 'customFunctionJavascriptFunction' in n.data.inputs);
  node.data.inputs.customFunctionJavascriptFunction = fs.readFileSync('C:/Flowise/_apply_lut_node.js', 'utf8');
  const made = await axios.post(BASE + '/api/v1/chatflows',
    { name: '32-Apply-LUT', flowData: JSON.stringify(fd), deployed: true, isPublic: false, type: 'AGENTFLOW' },
    { headers: H });
  console.log('created flow id:', made.data.id);
})();
