// Same purpose as Extract Scene List (Pano), but for World-Builder - kept
// as a SEPARATE node (not shared) because --force-pano and --force-world
// are independent controls, so the two consumers need independently
// force-suffixed arrays even though they start from the same scene list.
const previous = JSON.parse($previousOutput);
if (previous.error) return [];
const suffix = previous.force && previous.force.world ? ' --force' : '';
// The project travels with each item, so the downstream flow works on
// the same one rather than whichever is active by the time it runs.
const movieFlag = previous.movieId ? ' --movie ' + previous.movieId : '';
return previous.sceneScopes.map((s) => s + suffix + movieFlag);
