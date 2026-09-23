// The Iteration node needs iterationInput to be a plain array by itself -
// CustomFunction output always nests everything under one "content" string,
// so this small node exists just to unwrap that down to the array Iteration
// actually needs. On error, iterate zero times (a safe no-op) rather than
// guess - the full error/context is still visible on the previous node's
// own output in the execution trace. Appends --force per name when
// --force-characters (or bare --force) was passed to the orchestrator -
// 3-Character-Generator understands that flag on its own input.
const previous = JSON.parse($previousOutput);
if (previous.error) return [];
const suffix = previous.force && previous.force.characters ? ' --force' : '';
// The project travels with each item, so the downstream flow works on
// the same one rather than whichever is active by the time it runs.
const movieFlag = previous.movieId ? ' --movie ' + previous.movieId : '';
return previous.characterNames.map((n) => n + suffix + movieFlag);
