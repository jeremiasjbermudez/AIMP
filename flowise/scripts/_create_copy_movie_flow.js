// Create or update 41-Copy-Movie.
//   node _create_copy_movie_flow.js            -> creates
//   UPDATE_ID=<id> node _create_copy_movie_flow.js -> updates in place
const axios = require('axios');
const fs = require('fs');
const BASE = 'http://localhost:3010';
const H = { Authorization: 'Bearer <REDACTED>' };
(async () => {
  const code = fs.readFileSync('C:/Flowise/_copy_movie_node.js', 'utf8');
  // The source parses before anything is sent. A broken deploy looks from the
  // outside exactly like the feature being broken.
  let probe = code;
  for (const v of ['insforgeUrl', 'insforgeApiKey', 'comfyUrl']) probe = probe.split('$' + v).join('"x"');
  probe = probe.split('$flow').join('({ input: "" })');
  try { new Function('require', 'return (async () => {' + probe + '})'); }
  catch (e) { console.log('REFUSED - does not parse: ' + e.message); process.exit(1); }

  // Cloned from Image Edit so the Start wiring and the $insforge variables come
  // across already configured.
  const src = await axios.get(BASE + '/api/v1/chatflows/0afebffb-7fab-4ef1-a4fe-28da3f11a88d', { headers: H });
  const fd = JSON.parse(src.data.flowData);
  const node = fd.nodes.find((n) => n.data.inputs && 'customFunctionJavascriptFunction' in n.data.inputs);
  node.data.inputs.customFunctionJavascriptFunction = code;
  const flowData = JSON.stringify(fd);

  let id = process.env.UPDATE_ID;
  if (id) {
    await axios.put(BASE + '/api/v1/chatflows/' + id, { flowData }, { headers: H });
  } else {
    const made = await axios.post(
      BASE + '/api/v1/chatflows',
      { name: '41-Copy-Movie', flowData, deployed: true, isPublic: false, type: 'AGENTFLOW' },
      { headers: H }
    );
    id = made.data.id;
  }
  const back = JSON.parse((await axios.get(BASE + '/api/v1/chatflows/' + id, { headers: H })).data.flowData);
  const live = back.nodes.find((n) => n.data.inputs && n.data.inputs.customFunctionJavascriptFunction)
    .data.inputs.customFunctionJavascriptFunction;
  console.log('41-Copy-Movie id:', id, '| code matches:', live === code);
})().catch((e) => console.log('ERR', e.response ? JSON.stringify(e.response.data).slice(0, 400) : e.message));
