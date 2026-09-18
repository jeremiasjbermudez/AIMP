// Put the panorama flow's node code back, addressed BY ID.
//
// What went wrong: `_update_flow_fn.js` writes to `fd.nodes[1]` - an array
// POSITION. In this flow the array is [start, customFunctionAgentflow_0,
// customFunctionAgentflow_1], so index 1 is the RESOLVER, not the generator.
// A deploy of the generator landed on the resolver and overwrote it, and the
// flow died at the first line with `$resolveOutput is not defined` - the
// generator asking for an input variable only the second node is given.
//
// Positions move; ids do not. This addresses nodes by id and refuses to write
// if either is missing.
//
// Usage: node _deploy_panorama.js [--generator]
//   default      restore the resolver (node 0) only - the minimal fix
//   --generator  ALSO deploy _panoramic_generator_node.js into node 1
const fs = require('fs');
const axios = require('axios');

const BASE = 'http://localhost:3010';
const API_KEY = '<REDACTED>';
const FLOW = '3a462ae3-e268-4ebd-a357-d2235739b6cb';
const H = { Authorization: 'Bearer ' + API_KEY };

const TARGETS = [
  { id: 'customFunctionAgentflow_0', file: 'C:/Flowise/_pano_resolver_node.js', what: 'resolver' },
  { id: 'customFunctionAgentflow_1', file: 'C:/Flowise/_panoramic_generator_node.js', what: 'generator' }
];

(async () => {
  const alsoGenerator = process.argv.includes('--generator');
  const todo = alsoGenerator ? TARGETS : TARGETS.slice(0, 1);

  const got = await axios.get(`${BASE}/api/v1/chatflows/${FLOW}`, { headers: H });
  const fd = JSON.parse(got.data.flowData);
  console.log('flow:', got.data.name);

  for (const t of todo) {
    const node = fd.nodes.find((n) => n.id === t.id);
    if (!node) throw new Error(`Node ${t.id} is not in this flow - refusing to write.`);
    const code = fs.readFileSync(t.file, 'utf8');
    // Parsed before it is sent. A syntax error deployed into a flow only
    // surfaces when someone presses the button, as a NodeVM error with no file
    // and no line worth reading.
    new Function(`return (async () => {${code}})`);
    const was = node.data.inputs.customFunctionJavascriptFunction || '';
    node.data.inputs.customFunctionJavascriptFunction = code;
    console.log(`  ${t.id} (${t.what}): ${was.length} -> ${code.length} chars`);
  }

  await axios.put(
    `${BASE}/api/v1/chatflows/${FLOW}`,
    { flowData: JSON.stringify(fd) },
    { headers: { ...H, 'Content-Type': 'application/json' } }
  );

  // Read back, because a 200 on the PUT only says Flowise accepted the body.
  const after = JSON.parse((await axios.get(`${BASE}/api/v1/chatflows/${FLOW}`, { headers: H })).data.flowData);
  let ok = true;
  for (const t of todo) {
    const live = after.nodes.find((n) => n.id === t.id).data.inputs.customFunctionJavascriptFunction;
    const same = live === fs.readFileSync(t.file, 'utf8');
    console.log(`  ${t.id} matches on the server: ${same}`);
    if (!same) ok = false;
  }
  if (!ok) process.exit(1);
  console.log('deployed');
})().catch((e) => {
  console.error('FAILED:', (e.response && JSON.stringify(e.response.data).slice(0, 300)) || e.message);
  process.exit(1);
});
