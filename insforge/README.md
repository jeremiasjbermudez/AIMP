# The database

31 tables in the `public` schema. `schema.sql` is a schema-only dump: tables, columns, defaults,
indexes, constraints and row-level security policies, with **no rows**.

```bash
docker exec -i <postgres-container> psql -U postgres -d insforge < schema.sql
docker exec -i <postgres-container> psql -U postgres -d insforge -c "NOTIFY pgrst, 'reload schema';"
```

The `NOTIFY` is not optional. PostgREST caches the schema, and without it a freshly created table
or column reports as missing from the schema cache.

---

## The spine

Everything hangs off one project row. The story is decomposed downward, and every rendered asset
points back at the piece of story it belongs to.

```
movies
  └── scenes            one per location/time unit, numbered continuously across acts
        └── beats       the smallest story unit; carries its verbatim text and line range
              └── shots / director_shots   what the camera does for that beat
                    └── minimax_clips      the rendered video
```

`movies` is the only table with a partial unique index on `is_active`: exactly one project can be
active at a time, and most flows resolve which project they are working on from that flag rather
than being told.

## The tables

| Table | Cols | Holds |
|---|---|---|
| `movies` | 9 | one row per project: title, slug, storage bucket, active flag, status |
| `scenes` | 21 | a scene, its location prose, atmosphere, set dressing and ambience |
| `beats` | 22 | a story beat: summary, characters present, dialogue, verbatim text, line range, ordering index |
| `screenplay_chunks` | 10 | a long input split for incremental parsing, with each chunk's proposal and status |
| `documents` | 12 | uploaded source documents, e.g. a screenplay or a character bible |
| `characters` | 16 | a character: description, wardrobe, identity model settings |
| `character_images` | 11 | reference images per character, versioned, by kind |
| `movie_props` | 13 | a prop or vehicle, and its reference sheet |
| `movie_reference_images` | 6 | a loose pool of uploaded images usable anywhere |
| `scene_panos` | 12 | the 360° panorama for a scene |
| `scene_splats` | 10 | the trained 3D world for a scene: workspace name, splat file, backup |
| `scene_floor_plans` | 14 | measured geometry of a world: centre, up axis, facing, radius, named landmarks |
| `shot_cameras` | 19 | a camera as *intent* — which landmark to look at, from where, how far, how high — not coordinates |
| `camera_plates` | 14 | a plate rendered from a resolved camera, with the pose it resolved to |
| `camera_presets` | 9 | reusable camera vocabulary |
| `director_plans` | 8 | one version of a shot list |
| `director_shots` | 33 | a planned shot: type, characters, framing, its plate, and its render state |
| `shots` | 17 | the older per-beat shot record |
| `minimax_clips` | 24 | a video generation: mode, references, size, length, status, output path |
| `image_edits` | 20 | an image generation or edit, with its references and engine |
| `qwen_cleanups` | 13 | a correct-this-render job and its result |
| `movie_frames` | 7 | frames and snapshots saved into the project, which is what the image pickers list |
| `hyworlds` | 15 | a standalone 3D world not tied to a scene |
| `prompt_worlds` | 10 | a world generated from a description alone |
| `scores` | 26 | a generated music cue |
| `score_styles` | 9 | saved musical style settings |
| `voice_replacements` | 16 | a replaced voice track for a clip |
| `color_palettes` | 9 | a palette pulled off an image, and the grade derived from it |
| `lighting_presets` | 8 | a saved lighting setup |
| `lighting_preset_previews` | 5 | rendered previews of those setups |
| `prompt_log` | 14 | an audit trail of what was sent to which model |

## Conventions

- **Keys** are UUIDs with a database default.
- **Timestamps** are `timestamptz`, defaulted to now.
- **File paths** are stored as text, relative to the render host's root (`output/...`, `input/...`),
  or as a storage-bucket key for uploads. Nothing stores bytes in the database.
- **Job rows are the protocol.** The browser inserts a row with `status = 'queued'`, triggers a
  flow, and polls. The flow moves the row to `rendering`, then to `complete` with an output path,
  or `failed` with a message. The render survives the browser tab closing.
- **Scene numbers run continuously across acts.** Act 2 does not restart at 1. Several tables
  denormalise `act_number` and `scene_number` alongside their foreign keys, so a renumbering has
  to update them together or assets attach to the wrong scene.
- **`beats.beat_code` is a generated column.** Never write it.
- **Row-level security** is on for some tables and off for others, and where it is on the policy
  is usually permissive to the anonymous role. That is a deliberate choice for a machine-local
  single-operator tool, and it is not a posture to carry onto a network.
