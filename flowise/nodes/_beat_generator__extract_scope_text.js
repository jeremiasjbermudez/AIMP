const previous = JSON.parse($previousOutput);
if (previous.error) {
  return { error: previous.error };
}
const { scope, screenplayText, movieId, movieTitle, bucketName } = previous;

const lines = screenplayText.split(/\r\n|\r|\n/);

const sceneHeadingRe = /(\d+)\s+(INT|EXT)\b/;
const actBreakRe = /^END OF ACT\s+(\d+)/i;

const rawScenes = [];
let actNumber = 1;
for (let i = 0; i < lines.length; i++) {
  const line = lines[i];
  const actMatch = actBreakRe.exec(line);
  if (actMatch) {
    actNumber = parseInt(actMatch[1], 10) + 1;
    continue;
  }
  const sceneMatch = sceneHeadingRe.exec(line);
  if (sceneMatch) {
    rawScenes.push({
      sceneNumber: parseInt(sceneMatch[1], 10),
      actNumber,
      headingLine: i + 1,
      headingText: line.trim()
    });
  }
}

if (rawScenes.length === 0) {
  return { error: 'No scene headings found in the screenplay text (expected lines like "3 INT. THE CRYPT...").' };
}

const scenes = rawScenes.map((scene, idx) => {
  const nextHeadingLine = idx + 1 < rawScenes.length ? rawScenes[idx + 1].headingLine : lines.length + 1;
  return { ...scene, lineStart: scene.headingLine, lineEnd: nextHeadingLine - 1 };
});

function sliceLines(lineStart, lineEnd) {
  return lines.slice(lineStart - 1, lineEnd).join('\n');
}

function sliceLinesNumbered(lineStart, lineEnd) {
  const slice = [];
  for (let n = lineStart; n <= lineEnd; n++) {
    slice.push(`${n}: ${lines[n - 1]}`);
  }
  return slice.join('\n');
}

const preSceneEnd = scenes[0].lineStart - 1;
const hasPreScene = preSceneEnd >= 1 && lines.slice(0, preSceneEnd).some((l) => l.trim().length > 0);

if (scope.beat != null) {
  const axios = require('axios');
  const authHeaders = { Authorization: `Bearer ${$insforgeApiKey}` };
  const beatsRes = await axios.get(`${$insforgeUrl}/api/database/records/beats`, {
    params: {
      movie_id: `eq.${movieId}`,
      act_number: `eq.${scope.act}`,
      scene_number: `eq.${scope.scene}`,
      beat_number: `eq.${scope.beat}`,
      select: 'id,line_start,line_end'
    },
    headers: authHeaders
  });
  const existing = (beatsRes.data || [])[0];
  if (!existing) {
    return {
      error: `Beat A${scope.act}S${scope.scene}B${scope.beat} does not exist yet. Run A${scope.act}S${scope.scene} first to generate the scene's beats before regenerating a single one.`
    };
  }
  return {
    scope,
    movieId,
    movieTitle,
    bucketName,
    lineStart: existing.line_start,
    lineEnd: existing.line_end,
    lineNumberedText: sliceLinesNumbered(existing.line_start, existing.line_end)
  };
}

if (scope.scene != null) {
  const scene = scenes.find((s) => s.sceneNumber === scope.scene);
  if (!scene) {
    return { error: `Scene ${scope.scene} not found in the screenplay (found scenes: ${scenes.map((s) => s.sceneNumber).join(', ')}).` };
  }
  return {
    scope,
    movieId,
    movieTitle,
    bucketName,
    scenesInScope: [{ sceneNumber: scene.sceneNumber, actNumber: scene.actNumber, headingText: scene.headingText }],
    lineStart: scene.lineStart,
    lineEnd: scene.lineEnd,
    lineNumberedText: sliceLinesNumbered(scene.lineStart, scene.lineEnd)
  };
}

const actScenes = scenes.filter((s) => s.actNumber === scope.act);
const includesPreScene = scope.act === 1 && hasPreScene;
if (actScenes.length === 0 && !includesPreScene) {
  return { error: `Act ${scope.act} has no scenes in this screenplay (acts found: ${[...new Set(scenes.map((s) => s.actNumber))].join(', ')}).` };
}
const lineStart = includesPreScene ? 1 : actScenes[0].lineStart;
const lineEnd = actScenes.length > 0 ? actScenes[actScenes.length - 1].lineEnd : preSceneEnd;
const scenesInScope = [
  ...(includesPreScene ? [{ sceneNumber: null, actNumber: scope.act, headingText: '(pre-scene content, no scene number)' }] : []),
  ...actScenes.map((s) => ({ sceneNumber: s.sceneNumber, actNumber: s.actNumber, headingText: s.headingText }))
];
return {
  scope,
  movieId,
  movieTitle,
  bucketName,
  scenesInScope,
  lineStart,
  lineEnd,
  lineNumberedText: sliceLinesNumbered(lineStart, lineEnd)
};
