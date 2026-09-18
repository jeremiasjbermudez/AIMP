# Score & voice

Generate a music cue for a scene, and replace a voice on a finished clip while keeping the music
and the sync.

## What you get

**Score** (`score`) — generates music once for a whole scene or sequence, to lay under the edit.
Clips are told not to score themselves, because per-clip audio cannot match across a cut.

- *How* — four generators: two local variants of the same music model (full quality and a
  distilled turbo), a local long-form music model, and a cloud to-picture generator. Each shows
  a one-line note on what it trades.
- For the to-picture generator: a radio pair choosing a file from your computer or a clip from
  the project, with a preview; the video's length sets the length of the piece.
- **Enhance caption** — expands a couple of words into a full structured brief.
- Preset buttons that load complete worked example briefs into the box as starting points.
- *Ask the composer* — pick a beat and press **Suggest cues**; the agent proposes several
  contrasting cues (function, mood, arc, instrumentation, era, tempo, key, time signature) and
  each has a **Use this cue** button that loads it into the form. These are proposals only:
  nothing renders and nothing is written.
- *Write the cue* — an optional title, a length in seconds, and the caption box.
- For the local music generators: BPM, key, time signature and lyrics-language pickers, plus an
  optional reference-track upload that lends the cue its timbre and switches off the planning
  pass.
- A lyrics box with section tags. Left empty you get an instrumental of exactly the requested
  length; with lyrics the model decides the length.
- **Generate score**, a **Takes** number (1–6, the same brief with different seeds) and
  **Refresh**.
- A scores list showing title, status, length, a **3 more takes** button, **Delete**, the brief,
  any error, and an inline audio player.

**Post Voice** (`postvoice`) — replaces the voice in a clip that has already rendered, keeping
its music and effects and preserving lip-sync. Nothing is re-generated, so it costs no GPU time.

- A source radio pair: a clip from this project, or a video file from your computer. Either way
  a preview player is shown before a job is spent.
- A clip picker over the movie's finished clips, labelled with mode, frame count and resolution.
- A voice picker populated from the provider through the flow, with a **Reload voices** button.
- **Voice level** — conversions come back quieter than the original, so this lifts the new voice
  back over the music bed.
- **Replace voice** — uploads the file if needed, records a queued job and starts the
  conversion. Separation loads a large model, so the first run takes several minutes.
- **Refresh** to poll for results.
- A replacements list showing the voice name, status, a timing-match score (1.00 means every
  syllable lands where the original did), the source, any error, and the finished video inline.

## What it installs

**Tables**

- `scores` — a generated music cue.
- `score_styles` — saved musical style settings, and the taxonomy the cue agent draws on.
- `voice_replacements` — a replaced voice track for a clip.

**Flows**

- `19-Score-Generator` (`_score_node.js`) — renders a queued score, branching on the row's
  generator field across the music backends, or turns a rough brief into a finished caption in
  its enhance mode.
- `30-Score-Agent` (`_score_agent_node.js`) — reads a beat and proposes several contrasting
  cues. Not a randomiser: the story-bound axes are chosen from the taxonomy to fit the scene and
  only instrumentation and era vary freely, with the last take deliberately a reading against
  the scene. Every proposal is validated back against the taxonomy, so a tempo named in the
  prose cannot disagree with the structured value. It writes nothing and renders nothing.
- `18-Post-Voice` (`_post_voice_node.js`) — one flow with two actions, so the tab needs a single
  endpoint: list the available voices, or run one queued conversion. The audio is split, the
  vocal converted, and the result remixed under the original bed; the output is written where
  the tab can preview it through the same endpoint as everything else.

**ComfyUI node packs**

None.

**Models**

A music model with its own audio VAE and text encoders, and a speech model for the voice
conversion. Either music engine works on its own — one is around 23 GB, the other around 13 GB —
so you can install just the one you intend to use. Voice replacement additionally pulls a large
source-separation model on its first run, which is why that run takes minutes rather than
seconds, and it shells out to a local job that reads its own credentials server-side; nothing
reaches the browser.

## Before you install

- **core** — the database, the render host and the admin shell the two panels mount into.

Nothing else is a hard dependency, but neither tab is much use alone. Post Voice picks from
finished clips, so in practice you want the video module installed first; the cue agent reads
beats, so the screenplay module makes Ask the composer far more useful. Budget around 23 GB for
the main music engine or 13 GB for the alternative, plus the separation model that the voice
job fetches the first time it runs. This is a moderate module by disk, and light by VRAM
compared with video or image work.

## Install

```powershell
.\install-module.ps1 -Module audio
```

Restart the dev server afterwards; the Score and Post Voice tabs appear.

## How it fits

Both halves sit after the picture is made. Score reads beats and scenes and produces one
continuous piece per scene or sequence, deliberately outside clip rendering, because music
generated inside individual clips can never match across a cut. Post Voice takes finished clips
and swaps the performance without re-rendering them. What comes out of both goes to delivery: the
hand-off prefers a clip's re-voiced version wherever one exists, and the score is laid under the
assembled edit.

## Removing it

```powershell
.\uninstall-module.ps1 -Module audio
```

The tabs go and the tables stay by default, so generated cues and voice replacements survive.
Pass `-DropTables` to remove `scores`, `score_styles` and `voice_replacements` as well.
