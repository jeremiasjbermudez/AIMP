// Deploy _prompt_enhancer_node.js into 11-MiniMax-Prompt-Enhancer.
//
// By node ID, never by array position. `_update_flow_fn.js` writes to
// fd.nodes[1] and that is how the panorama flow's resolver got overwritten by
// the generator - index 1 is not the same node in every flow.
const fs = require('fs');
const axios = require('axios');

const BASE = 'http://localhost:3010';
const API_KEY = '<REDACTED>';
const FLOW = '50b8069c-3afe-4f15-9bc8-89aef10773cf';
const SOURCE = 'C:/Flowise/_prompt_enhancer_node.js';
const H = { Authorization: 'Bearer ' + API_KEY };

(async () => {
  const got = await axios.get(`${BASE}/api/v1/chatflows/${FLOW}`, { headers: H });
  const fd = JSON.parse(got.data.flowData);
  console.log('flow:', got.data.name);

  // The only custom-function node in this flow, found by id rather than assumed.
  const node = fd.nodes.find((n) => n.id === 'customFunctionAgentflow_0');
  if (!node) throw new Error('customFunctionAgentflow_0 is not in this flow - refusing to write.');

  const code = fs.readFileSync(SOURCE, 'utf8');
  // Parsed before sending: a syntax error deployed into a flow surfaces only
  // when someone presses the button, as a NodeVM error with no line worth reading.
  new Function(`return (async () => {${code}})`);

  const was = node.data.inputs.customFunctionJavascriptFunction || '';
  node.data.inputs.customFunctionJavascriptFunction = code;
  console.log(`  ${was.length} -> ${code.length} chars`);

  await axios.put(
    `${BASE}/api/v1/chatflows/${FLOW}`,
    { flowData: JSON.stringify(fd) },
    { headers: { ...H, 'Content-Type': 'application/json' } }
  );

  const after = JSON.parse((await axios.get(`${BASE}/api/v1/chatflows/${FLOW}`, { headers: H })).data.flowData);
  const live = after.nodes.find((n) => n.id === 'customFunctionAgentflow_0').data.inputs.customFunctionJavascriptFunction;
  console.log('  code matches on the server:', live === code);
  if (live !== code) process.exit(1);
})().catch((e) => {
  console.error('FAILED:', (e.response && JSON.stringify(e.response.data).slice(0, 300)) || e.message);
  process.exit(1);
});
