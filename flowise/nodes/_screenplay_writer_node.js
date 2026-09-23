// 22-Screenplay-Writer: a conversation that produces a whole screenplay.
//
// The writer describes an idea and gets a complete script back, then refines it
// by talking ("darker", "lose the brother"). Each turn returns the FULL
// screenplay again rather than a patch, because the next thing that happens to
// it is being pasted into the breakdown, which needs the whole document.
//
// No tools and no database access: this flow invents, it does not read or write
// the movie. Committing what it produces is the breakdown's job.
const axios = require('axios');
// @include llm
// ---------------------------------------------------------------------------
const systemPrompt = $systemPrompt;

let parsed;
try {
  parsed = JSON.parse(($flow.input || '').toString());
} catch (e) {
  return { error: 'Expected JSON input {"messages":[{"role":"user","content":"..."}]}' };
}

const incoming = Array.isArray(parsed.messages) ? parsed.messages : [];
const messages = incoming
  .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && String(m.content || '').trim())
  .map((m) => ({ role: m.role, content: String(m.content) }));

if (!messages.length) return { error: 'Nothing to write from - send at least one message.' };

// A screenplay is long, and every refinement resends the previous draft, so the
// history grows fast. Keeping the first turn (the premise) plus a recent window
// holds the brief in view without paying to replay every superseded draft.
const MAX_TURNS = 9;
const trimmed =
  messages.length <= MAX_TURNS
    ? messages
    : [messages[0]].concat(messages.slice(messages.length - (MAX_TURNS - 1)));

let reply;
try {
  const res = await llmChat(
    {
      model: ollamaModel,
      stream: false,
      // The writer asked not to watch it think, and the reply is pasted
      // straight into the breakdown - reasoning text would corrupt the script.
      think: false,
      // Warm enough to invent, cool enough to hold the output format.
      options: { temperature: 0.85, num_ctx: 32768 },
      messages: [{ role: 'system', content: systemPrompt }].concat(trimmed)
    },
    // A full screenplay is thousands of tokens on a local box; the default
    // two minutes is not enough and the failure looks like a hang.
    { timeout: 900000 }
  );
  reply = ((res.data && res.data.message && res.data.message.content) || '').trim();
} catch (e) {
  const detail = e.response ? JSON.stringify(e.response.data).slice(0, 400) : e.message;
  return { error: 'The model did not answer: ' + detail };
}

if (!reply) return { error: 'The model returned nothing.' };

// Strip the habits the instruction forbids but models fall back into anyway.
reply = reply.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
reply = reply.replace(/^```[a-z]*\s*\n?/i, '').replace(/\n?```\s*$/i, '').trim();
reply = reply.replace(/^(here(?:'s| is)[^\n]*screenplay[^\n]*:?)\s*\n+/i, '').trim();

// Scene numbering is mechanical, so it is enforced here rather than hoped for.
// Observed failure: the model fills the trailing slot with a DAY number (a real
// screenplay convention) instead of repeating the scene number, and it can
// restart numbering at each act. Both corrupt the breakdown, and both are
// fixable exactly - renumber in document order and make the two ends agree.
//
// Written as one multiline replace rather than split/join so this source
// carries no newline literals for the tooling that generates it to mangle.
let sceneNo = 0;
reply = reply.replace(
  /^[ \t]*(\d+)[ \t]+(INT|EXT)\.[ \t]*(.+?)[ \t]*$/gim,
  function (whole, lead, ie, body) {
    sceneNo += 1;
    return sceneNo + ' ' + ie.toUpperCase() + '. ' + body.replace(/\s+\d+$/, '').trim() + ' ' + sceneNo;
  }
);

// A short piece often comes back with no act markers at all. The breakdown uses
// "END OF ACT n" to close the last act, so a script without one leaves its final
// scenes outside any act. One is appended when the model wrote none - it is
// never inserted between scenes, since where an act break falls is a story
// decision and guessing it would be worse than leaving one act.
if (!/^END OF ACT\s+\d+/im.test(reply)) {
  reply = reply.replace(/\s*$/, '') + String.fromCharCode(10, 10) + 'END OF ACT 1';
}

// Whether this looks like a script decides if the UI offers "Use for breakdown",
// so the answer is computed here rather than re-derived from the text in React.
const headings = (reply.match(/^\s*\d+\s+(INT|EXT)\.[^\n]*$/gim) || []).length;
const acts = (reply.match(/^END OF ACT\s+\d+/gim) || []).length;

return {
  reply: reply,
  isScreenplay: headings > 0,
  scenes: headings,
  acts: acts
};
