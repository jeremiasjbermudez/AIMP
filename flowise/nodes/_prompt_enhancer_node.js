const rawInput = ($flow.input || '').toString();
let parsed;
try { parsed = JSON.parse(rawInput); } catch (e) {
  return { error: 'Expected JSON input {"draft":"...","motion":"...","imageBase64":"..."}, got: ' + rawInput.slice(0, 200) };
}

const axios = require('axios');
// @include llm
// ---------------------------------------------------------------------------
// The system prompt can now come FROM THE CALLER, so each video tab can be told
// what to do with its clips without editing this flow.
//
// $systemPrompt - the one configured on the node - stays the default, so every
// existing caller behaves exactly as before. An override only applies when one
// is actually sent and is not blank: an empty box means "no opinion", not
// "run with no system prompt at all", which would strip the output contract and
// return prose instead of a prompt.
const systemPrompt = (parsed.systemPrompt || '').toString().trim() || $systemPrompt;
const systemFrom = (parsed.systemPrompt || '').toString().trim() ? 'caller' : 'flow';

const draft = (parsed.draft || '').toString().trim();
const motion = (parsed.motion || '').toString().trim();
const imageBase64 = (parsed.imageBase64 || '').toString().trim();

if (!draft && !motion && !imageBase64) {
  return { error: 'Nothing to enhance: supply a motion request, a draft prompt, or an image.' };
}

// Dialogue is script, not description, so it has to survive the rewrite intact.
// The instruction says as much, but instructions are not a guarantee - an
// earlier version silently dropped two of four lines - so the count is checked
// here and a shortfall is never returned as if it were a success.
const countDialogue = (t) => (String(t).match(/<d>/gi) || []).length;
const expectedLines = Math.max(countDialogue(draft), countDialogue(motion));

const userParts = [];
if (motion) userParts.push('MOTION REQUEST: ' + motion);
if (draft) userParts.push('DRAFT PROMPT (mine for motion and speech only; discard its structure and scene description):\n' + draft);
if (!motion && !draft) userParts.push('MOTION REQUEST: infer a single natural motion for this image.');
if (expectedLines > 0) {
  userParts.push('This source contains ' + expectedLines + ' dialogue line(s). Your output must contain exactly ' + expectedLines + ' <d> tag(s), word for word, in the same order.');
}

const baseMessage = { role: 'user', content: userParts.join('\n\n') };
// qwen3.8 is multimodal; Ollama takes images as bare base64 on the message.
if (imageBase64) baseMessage.images = [imageBase64.replace(/^data:[^;]+;base64,/, '')];

async function ask(messages) {
  const res = await llmChat(
    {
      model: ollamaModel,
      stream: false,
      // The model has a thinking capability; the output contract wants the
      // prompt only, so reasoning is disabled rather than filtered after.
      think: false,
      options: { temperature: 0.7 },
      messages: messages
    },
    { timeout: 300000 }
  );
  return ((res.data && res.data.message && res.data.message.content) || '').trim();
}

function clean(raw) {
  let text = String(raw).trim();
  // Belt and braces against the preamble habits the instruction forbids.
  text = text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  text = text.replace(/^(here(?:'s| is) (?:your |the )?prompt:?|prompt:)\s*/i, '').trim();
  text = text.replace(/^```[a-z]*\s*/i, '').replace(/```$/, '').trim();
  // The model has been observed echoing the output contract back.
  const placeholder = text.search(/<the prompt string|no labels, no headers, no commentary>/i);
  if (placeholder > 0) text = text.slice(0, placeholder).trim();
  const blocks = text.split(new RegExp('\\n\\s*\\n')).map((b) => b.trim()).filter(Boolean);
  // Collapse a repeated answer to its first block ONLY when doing so loses no
  // dialogue. A genuine multi-line dialogue prompt spans blocks, and blindly
  // taking blocks[0] would drop lines - the exact bug this guard exists for.
  if (blocks.length > 1 && countDialogue(blocks[0]) >= countDialogue(text)) text = blocks[0];
  return text.trim();
}

const messages = [{ role: 'system', content: systemPrompt }, baseMessage];

let text;
try {
  text = clean(await ask(messages));
} catch (e) {
  const detail = e.response && e.response.data ? JSON.stringify(e.response.data).slice(0, 400) : (e.message || String(e));
  return { error: 'Ollama request failed: ' + detail };
}

let retried = false;
if (expectedLines > 0 && countDialogue(text) < expectedLines) {
  retried = true;
  try {
    const followUp = messages.concat([
      { role: 'assistant', content: text },
      {
        role: 'user',
        content:
          'You dropped dialogue. Your output had ' + countDialogue(text) + ' <d> tag(s) but the source has ' +
          expectedLines + '. Rewrite with every line restored, verbatim and in order. Dialogue does not count ' +
          'toward the word budget. Output the prompt only.'
      }
    ]);
    const second = clean(await ask(followUp));
    // Keep whichever attempt preserved more of the script.
    if (countDialogue(second) >= countDialogue(text)) text = second;
  } catch (e) {
    // Keep the first attempt; the check below still reports the shortfall.
  }
}

if (!text) return { error: 'Model returned an empty prompt.' };

const gotLines = countDialogue(text);
if (expectedLines > 0 && gotLines < expectedLines) {
  return {
    error:
      'Enhancer dropped dialogue: kept ' + gotLines + ' of ' + expectedLines + ' lines even after a retry. ' +
      'Your prompt has been left unchanged - use "Fill from beat" for this shot.',
    droppedDialogue: true,
    expectedLines: expectedLines,
    gotLines: gotLines
  };
}

// The 20-60 word budget covers motion text only, so report it that way rather
// than a total that a dialogue-heavy beat would blow past legitimately.
const motionWords = text.replace(/<d>[\s\S]*?<\/d>/gi, '').split(/\s+/).filter(Boolean).length;
// systemFrom is reported so the tab can say which instructions actually ran.
// Without it a pasted system prompt that never arrived looks identical to one
// that did, and the only evidence is the output being subtly unchanged.
return { prompt: text, motionWords, dialogueLines: gotLines, retried, model: ollamaModel, systemFrom };
