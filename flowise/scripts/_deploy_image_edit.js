const axios = require('axios');
const fs = require('fs');
const BASE = 'http://localhost:3010';
const API_KEY = '<REDACTED>';
const ID = '0afebffb-7fab-4ef1-a4fe-28da3f11a88d';
const H = { Authorization: 'Bearer ' + API_KEY };
(async () => {
  const r = await axios.get(BASE + '/api/v1/chatflows/' + ID, { headers: H });
  const fd = JSON.parse(r.data.flowData);
  const code = fs.readFileSync('C:/Flowise/_image_edit_node.js', 'utf8');
  const node = fd.nodes.find((n) => n.data.inputs && 'customFunctionJavascriptFunction' in n.data.inputs);
  if (!node) throw new Error('no custom function node');
  node.data.inputs.customFunctionJavascriptFunction = code;
  await axios.put(BASE + '/api/v1/chatflows/' + ID, { flowData: JSON.stringify(fd) }, { headers: H });
  const back = JSON.parse((await axios.get(BASE + '/api/v1/chatflows/' + ID, { headers: H })).data.flowData);
  const live = back.nodes.find((n) => n.data.inputs && n.data.inputs.customFunctionJavascriptFunction)
    .data.inputs.customFunctionJavascriptFunction;
  console.log('deployed', code.length, 'chars; live matches:', live === code);
  console.log('live has old negatives:', /NO human eyes|no pupils|not transparent/.test(live));
})();
