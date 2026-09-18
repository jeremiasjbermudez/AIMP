const axios = require('axios');
const fs = require('fs');
const BASE = 'http://localhost:3010';
const H = { Authorization: 'Bearer <REDACTED>' };
(async () => {
  // Clone the deployed Image Edit flow so the Start/CustomFunction wiring and
  // the $insforgeUrl / $comfyUrl variables come across already configured.
  const src = await axios.get(BASE + '/api/v1/chatflows/0afebffb-7fab-4ef1-a4fe-28da3f11a88d', { headers: H });
  const fd = JSON.parse(src.data.flowData);
  const node = fd.nodes.find((n) => n.data.inputs && 'customFunctionJavascriptFunction' in n.data.inputs);
  node.data.inputs.customFunctionJavascriptFunction = fs.readFileSync('C:/Flowise/_qwen_image_edit_node.js', 'utf8');
  const made = await axios.post(
    BASE + '/api/v1/chatflows',
    { name: '28-Qwen-Image-Edit', flowData: JSON.stringify(fd), deployed: true, isPublic: false, type: 'AGENTFLOW' },
    { headers: H }
  );
  console.log('created flow id:', made.data.id);
})();
