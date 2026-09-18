// Deploy 5-3DGS-World-Builder: resolver into node 0, builder into node 1.
//
// BY ID. `_update_flow_fn.js` writes to fd.nodes[1] - an array position - and
// that is how the panorama flow's resolver got overwritten by its generator.
// Positions move; ids do not.
const fs = require('fs');
const axios = require('axios');

const BASE = 'http://localhost:3010';
const KEY = '<REDACTED>';
const FLOW = '1b313782-0a77-40ac-9e8d-1d4df3eaf708';
const H = { Authorization: 'Bearer ' + KEY };

const TARGETS = [
  { id: 'customFunctionAgentflow_0', file: 'C:/Flowise/_world_builder_resolver.js', what: 'resolver' },
  { id: 'customFunctionAgentflow_1', file: 'C:/Flowise/_world_builder_node.js', what: 'builder' }
];

(async () => {
  const got = await axios.get(`${BASE}/api/v1/chatflows/${FLOW}`, { headers: H });
  const fd = JSON.parse(got.data.flowData);
  console.log('flow:', got.data.name);

  for (const t of TARGETS) {
    const node = fd.nodes.find((n) => n.id === t.id);
    if (!node) throw new Error(`${t.id} is not in this flow - refusing to write.`);
    const code = fs.readFileSync(t.file, 'utf8');
    // Parsed before it is sent: a syntax error deployed into a flow only shows
    // up when someone presses the button, as a NodeVM error with no line worth
    // reading.
    new Function(`return (async () => {${code}})`);
    const was = (node.data.inputs.customFunctionJavascriptFunction || '').length;
    node.data.inputs.customFunctionJavascriptFunction = code;
    console.log(`  ${t.id} (${t.what}): ${was} -> ${code.length} chars`);
  }

  await axios.put(`${BASE}/api/v1/chatflows/${FLOW}`, { flowData: JSON.stringify(fd) }, {
    headers: { ...H, 'Content-Type': 'application/json' }
  });

  const after = JSON.parse((await axios.get(`${BASE}/api/v1/chatflows/${FLOW}`, { headers: H })).data.flowData);
  let ok = true;
  for (const t of TARGETS) {
    const live = after.nodes.find((n) => n.id === t.id).data.inputs.customFunctionJavascriptFunction;
    const same = live === fs.readFileSync(t.file, 'utf8');
    console.log(`  ${t.id} matches on the server: ${same}`);
    if (!same) ok = false;
  }
  if (!ok) process.exit(1);
  console.log('deployed');
})().catch((e) => {
  console.error('FAILED:', (e.response && JSON.stringify(e.response.data).slice(0, 400)) || e.message);
  process.exit(1);
});
