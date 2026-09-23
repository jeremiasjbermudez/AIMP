// Same unwrap-for-Iteration purpose as Extract Character List. Appends
// --force per scene when --force-pano (or bare --force) was passed -
// 4-Panoramic-Generator already understands that flag on its own input.
const previous = JSON.parse($previousOutput);
if (previous.error) return [];
const suffix = previous.force && previous.force.pano ? ' --force' : '';
// The project travels with each item, so the downstream flow works on
// the same one rather than whichever is active by the time it runs.
const movieFlag = previous.movieId ? ' --movie ' + previous.movieId : '';
return previous.sceneScopes.map((s) => s + suffix + movieFlag);
