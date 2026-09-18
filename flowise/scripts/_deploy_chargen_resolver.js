const axios = require('axios'); const fs = require('fs');
const BASE = 'http://localhost:3010';
const ID = '0e72b75a-ad63-4505-81c4-9d1f82f8d4a4';
const H = { Authorization: 'Bearer <REDACTED>' };
(async () => {
  const r = await axios.get(BASE + '/api/v1/chatflows/' + ID, { headers: H });
  const fd = JSON.parse(r.data.flowData);
  const code = fs.readFileSync('C:/Flowise/_chargen_resolver_node.js', 'utf8');
  // Node 1 is the resolver: the FIRST custom function in the graph.
  const node = fd.nodes.filter((n) => n.data.inputs && 'customFunctionJavascriptFunction' in n.data.inputs)[0];
  node.data.inputs.customFunctionJavascriptFunction = code;
  await axios.put(BASE + '/api/v1/chatflows/' + ID, { flowData: JSON.stringify(fd) }, { headers: H });
  const back = JSON.parse((await axios.get(BASE + '/api/v1/chatflows/' + ID, { headers: H })).data.flowData);
  const live = back.nodes.filter((n) => n.data.inputs && n.data.inputs.customFunctionJavascriptFunction)[0]
    .data.inputs.customFunctionJavascriptFunction;
  console.log('deployed', code.length, 'chars; live matches:', live === code);
  console.log('version regex intact:', /--version\\s\+\(\\d\+\)/.test(live) || live.includes('--version\s+(\d+)'));
})();
