const axios = require('axios');
const fs = require('fs');
const BASE = 'http://localhost:3010';
const H = { Authorization: 'Bearer <REDACTED>' };
(async () => {
  // Clone the deployed Image Edit flow so the Start/CustomFunction wiring and
  // the $insforgeUrl / $insforgeApiKey variables come across already configured.
  const src = await axios.get(BASE + '/api/v1/chatflows/0afebffb-7fab-4ef1-a4fe-28da3f11a88d', { headers: H });
  const fd = JSON.parse(src.data.flowData);
  const node = fd.nodes.find((n) => n.data.inputs && 'customFunctionJavascriptFunction' in n.data.inputs);
  const code = fs.readFileSync('C:/Flowise/_director_node.js', 'utf8');
  node.data.inputs.customFunctionJavascriptFunction = code;
  const made = await axios.post(
    BASE + '/api/v1/chatflows',
    { name: '39-Director', flowData: JSON.stringify(fd), deployed: true, isPublic: false, type: 'AGENTFLOW' },
    { headers: H }
  );
  const back = JSON.parse((await axios.get(BASE + '/api/v1/chatflows/' + made.data.id, { headers: H })).data.flowData);
  const live = back.nodes.find((n) => n.data.inputs && n.data.inputs.customFunctionJavascriptFunction).data.inputs.customFunctionJavascriptFunction;
  console.log('created flow id:', made.data.id, '| code matches:', live === code);
})().catch((e) => console.log('ERR', e.response ? JSON.stringify(e.response.data).slice(0, 400) : e.message));
