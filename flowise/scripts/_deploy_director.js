// Push _director_node.js into the live 39-Director flow.
//
// It parses the source BEFORE sending it. A broken deploy once shipped to the
// running app and every Director action failed with a syntax error, which looks
// from the outside exactly like the feature being broken rather than the file.
// And it reads the code back afterwards, because a PUT returning 200 is not the
// same as the flow holding what was sent.
const axios = require('axios');
const fs = require('fs');
const BASE = 'http://localhost:3010';
const H = { Authorization: 'Bearer <REDACTED>' };
const FLOW = 'a9e6b1eb-49ae-4aa3-ae8e-fa4168211d69';
const SRC = 'C:/Flowise/_director_node.js';

(async () => {
  const code = fs.readFileSync(SRC, 'utf8');

  // The Flowise $variables are not JavaScript, so they are stood in for before
  // the parse. The node body runs inside an async function, hence the wrapper.
  let probe = code;
  for (const v of ['insforgeUrl', 'insforgeApiKey', 'comfyUrl', 'ollamaUrl', 'ollamaModel']) {
    probe = probe.split('$' + v).join('"x"');
  }
  probe = probe.split('$flow').join('({ input: "" })');
  try {
    new Function('require', 'return (async () => {' + probe + '})');
  } catch (e) {
    console.log('REFUSED - the source does not parse: ' + e.message);
    process.exit(1);
  }

  const r = await axios.get(BASE + '/api/v1/chatflows/' + FLOW, { headers: H });
  const fd = JSON.parse(r.data.flowData);
  const node = fd.nodes.find((n) => n.data.inputs && 'customFunctionJavascriptFunction' in n.data.inputs);
  if (!node) {
    console.log('REFUSED - no custom function node in that flow.');
    process.exit(1);
  }
  node.data.inputs.customFunctionJavascriptFunction = code;

  const put = await axios.put(
    BASE + '/api/v1/chatflows/' + FLOW,
    { flowData: JSON.stringify(fd) },
    { headers: H, validateStatus: () => true }
  );
  const back = JSON.parse((await axios.get(BASE + '/api/v1/chatflows/' + FLOW, { headers: H })).data.flowData);
  const live = back.nodes.find((n) => n.data.inputs && n.data.inputs.customFunctionJavascriptFunction).data.inputs
    .customFunctionJavascriptFunction;
  console.log('PUT ' + put.status + ' | ' + code.length + ' chars | code matches: ' + (live === code));
  if (live !== code) process.exit(1);
})().catch((e) => {
  console.log('ERR ' + (e.response ? JSON.stringify(e.response.data).slice(0, 400) : e.message));
  process.exit(1);
});
