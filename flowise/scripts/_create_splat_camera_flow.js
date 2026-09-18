// Create (or update) 45-Splat-Camera from _splat_camera_node.js.
//
// Cloned from Image Edit so the node inherits $insforgeUrl / $insforgeApiKey /
// $comfyUrl, the same way every other tool flow here was made. The node itself
// does not use them - the Python talks to InsForge directly - but a flow built
// from a different template would have a different input-variable set, and a
// later edit that reaches for one would fail at run time rather than now.
//
// UPDATE_ID=<id> node _create_splat_camera_flow.js   updates in place.
const axios = require('axios');
const fs = require('fs');

const BASE = 'http://localhost:3010';
const H = { Authorization: 'Bearer <REDACTED>' };
const NAME = '45-Splat-Camera';
const SOURCE = 'C:/Flowise/_splat_camera_node.js';
const TEMPLATE = '0afebffb-7fab-4ef1-a4fe-28da3f11a88d'; // 26-Image-Edit

(async () => {
  const code = fs.readFileSync(SOURCE, 'utf8');

  // Parse it before it goes anywhere. A syntax error deployed into a flow only
  // surfaces when someone presses the button, as a NodeVM error with no file and
  // no line worth reading.
  let probe = code;
  for (const v of ['insforgeUrl', 'insforgeApiKey', 'comfyUrl', 'ollamaUrl', 'ollamaModel']) {
    probe = probe.split('$' + v).join('"x"');
  }
  probe = probe.split('$flow').join('({ input: "" })');
  try {
    new Function('require', 'process', 'return (async () => {' + probe + '})');
  } catch (e) {
    console.log('REFUSED - does not parse: ' + e.message);
    process.exit(1);
  }

  const src = await axios.get(`${BASE}/api/v1/chatflows/${TEMPLATE}`, { headers: H });
  const fd = JSON.parse(src.data.flowData);
  const node = fd.nodes.find((n) => n.data.inputs && 'customFunctionJavascriptFunction' in n.data.inputs);
  if (!node) {
    console.log('REFUSED - the template has no custom function node');
    process.exit(1);
  }
  node.data.inputs.customFunctionJavascriptFunction = code;
  const flowData = JSON.stringify(fd);

  let id = process.env.UPDATE_ID;
  if (id) {
    await axios.put(`${BASE}/api/v1/chatflows/${id}`, { flowData }, { headers: H });
  } else {
    const made = await axios.post(
      `${BASE}/api/v1/chatflows`,
      { name: NAME, flowData, deployed: true, isPublic: false, type: 'AGENTFLOW' },
      { headers: H }
    );
    id = made.data.id;
  }

  // Read it back: a 200 on the write only says Flowise accepted the body.
  const back = JSON.parse((await axios.get(`${BASE}/api/v1/chatflows/${id}`, { headers: H })).data.flowData);
  const live = back.nodes.find((n) => n.data.inputs && n.data.inputs.customFunctionJavascriptFunction)
    .data.inputs.customFunctionJavascriptFunction;
  console.log(`${NAME} id: ${id} | matches: ${live === code}`);
  console.log(`add to pipeline-admin-next/.env:  VITE_SPLAT_CAMERA_ID=${id}`);
})().catch((e) => console.log('ERR', e.response ? JSON.stringify(e.response.data).slice(0, 300) : e.message));
