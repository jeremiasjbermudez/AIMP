--
-- PostgreSQL database dump
--

\restrict jrZ5CfmcVAtLOJMIKu1nBYdWcr1xVsrO1ELH88j1cxyzpHcXVRxWi0JPhL2lx7e

-- Dumped from database version 15.18 (Debian 15.18-1.pgdg13+1)
-- Dumped by pg_dump version 18.4 (Debian 18.4-1.pgdg13+1)

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: public; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA public;


--
-- Name: SCHEMA public; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON SCHEMA public IS 'standard public schema';


--
-- Name: match_book_chunks(public.vector, uuid, integer, double precision); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.match_book_chunks(query_embedding public.vector, filter_movie_id uuid, match_count integer DEFAULT 5, match_threshold double precision DEFAULT 0.35) RETURNS TABLE(id uuid, content text, chunk_index integer, similarity double precision)
    LANGUAGE sql STABLE
    AS $$
  SELECT
    public.book_chunks.id,
    public.book_chunks.content,
    public.book_chunks.chunk_index,
    1 - (public.book_chunks.embedding <=> query_embedding) AS similarity
  FROM public.book_chunks
  WHERE public.book_chunks.movie_id = filter_movie_id
    AND 1 - (public.book_chunks.embedding <=> query_embedding) >= match_threshold
  ORDER BY public.book_chunks.embedding <=> query_embedding
  LIMIT match_count;
$$;


--
-- Name: screenplay_apply_structure(uuid, jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.screenplay_apply_structure(p_movie_id uuid, p_beats jsonb) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
DECLARE
  v_kept    uuid[];
  v_blocked text;
BEGIN
  -- Refuse an empty payload outright. The reconcile below treats "absent from
  -- the payload" as "delete", so an accidental empty call would silently wipe
  -- every beat in the movie. Deleting the last beat must be explicit.
  IF p_beats IS NULL OR jsonb_typeof(p_beats) <> 'array' OR jsonb_array_length(p_beats) = 0 THEN
    RAISE EXCEPTION
      'screenplay_apply_structure requires a non-empty beat array; refusing to delete every beat of movie %',
      p_movie_id USING ERRCODE = 'invalid_parameter_value';
  END IF;

  SET CONSTRAINTS
    public.beats_movie_sequence_index_unique,
    public.beats_movie_act_scene_beat_unique DEFERRED;

  SELECT coalesce(array_agg(x.id) FILTER (WHERE x.id IS NOT NULL), '{}')
    INTO v_kept
    FROM jsonb_to_recordset(p_beats) AS x(id uuid);

  -- shots.beat_id is ON DELETE NO ACTION, so a beat that has already been
  -- rendered cannot be removed. Surface that as a readable error naming the
  -- beats, rather than letting a raw foreign key violation reach the UI.
  SELECT string_agg(DISTINCT coalesce(b.beat_code, 'seq ' || b.sequence_index), ', ')
    INTO v_blocked
    FROM public.beats b
    JOIN public.shots s ON s.beat_id = b.id
   WHERE b.movie_id = p_movie_id AND NOT (b.id = ANY(v_kept));
  IF v_blocked IS NOT NULL THEN
    RAISE EXCEPTION
      'Cannot delete beat(s) % - they already have shots. Delete those shots first.',
      v_blocked USING ERRCODE = 'foreign_key_violation';
  END IF;

  DELETE FROM public.beats b
   WHERE b.movie_id = p_movie_id AND NOT (b.id = ANY(v_kept));

  UPDATE public.beats b SET
    sequence_index = i.sequence_index,
    act_number     = i.act_number,
    scene_number   = i.scene_number,
    beat_number    = i.beat_number,
    scene_heading  = i.scene_heading,
    int_ext        = i.int_ext,
    location       = i.location,
    time_of_day    = i.time_of_day,
    summary        = coalesce(i.summary, ''),
    action_text    = i.action_text,
    raw_text       = coalesce(i.raw_text,    b.raw_text),
    line_start     = coalesce(i.line_start,  b.line_start),
    line_end       = coalesce(i.line_end,    b.line_end),
    source_hash    = coalesce(i.source_hash, b.source_hash),
    characters     = coalesce(i.characters, '[]'::jsonb),
    objects        = coalesce(i.objects,    '[]'::jsonb),
    dialogue       = coalesce(i.dialogue,   '[]'::jsonb)
  FROM jsonb_to_recordset(p_beats) AS i(
    id uuid, sequence_index int, act_number int, scene_number int,
    beat_number int, scene_heading text, int_ext text, location text,
    time_of_day text, summary text, action_text text, raw_text text,
    line_start int, line_end int, source_hash text,
    characters jsonb, objects jsonb, dialogue jsonb)
  WHERE b.id = i.id AND b.movie_id = p_movie_id;

  INSERT INTO public.beats (
    movie_id, sequence_index, act_number, scene_number, beat_number,
    scene_heading, int_ext, location, time_of_day, summary, action_text,
    raw_text, line_start, line_end, source_hash, characters, objects, dialogue)
  SELECT p_movie_id, i.sequence_index, i.act_number, i.scene_number,
         i.beat_number, i.scene_heading, i.int_ext, i.location, i.time_of_day,
         coalesce(i.summary, ''), i.action_text,
         coalesce(i.raw_text, ''), coalesce(i.line_start, 0),
         coalesce(i.line_end, 0), i.source_hash,
         coalesce(i.characters, '[]'::jsonb),
         coalesce(i.objects,    '[]'::jsonb),
         coalesce(i.dialogue,   '[]'::jsonb)
    FROM jsonb_to_recordset(p_beats) AS i(
      id uuid, sequence_index int, act_number int, scene_number int,
      beat_number int, scene_heading text, int_ext text, location text,
      time_of_day text, summary text, action_text text, raw_text text,
      line_start int, line_end int, source_hash text,
      characters jsonb, objects jsonb, dialogue jsonb)
   WHERE i.id IS NULL;

  RETURN coalesce(
    (SELECT jsonb_agg(to_jsonb(b) ORDER BY b.sequence_index)
       FROM public.beats b WHERE b.movie_id = p_movie_id),
    '[]'::jsonb);
END
$$;


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: beats; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.beats (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    movie_id uuid NOT NULL,
    sequence_index integer NOT NULL,
    act_number integer NOT NULL,
    scene_number integer,
    beat_number integer,
    line_start integer NOT NULL,
    line_end integer NOT NULL,
    scene_heading text,
    int_ext text,
    location text,
    time_of_day text,
    summary text NOT NULL,
    raw_text text NOT NULL,
    characters jsonb DEFAULT '[]'::jsonb NOT NULL,
    objects jsonb DEFAULT '[]'::jsonb NOT NULL,
    dialogue jsonb DEFAULT '[]'::jsonb NOT NULL,
    source_hash text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    beat_code text GENERATED ALWAYS AS (
CASE
    WHEN ((scene_number IS NOT NULL) AND (beat_number IS NOT NULL)) THEN ((((('A'::text || act_number) || 'S'::text) || scene_number) || 'B'::text) || beat_number)
    ELSE NULL::text
END) STORED,
    action_text text,
    CONSTRAINT beats_int_ext_check CHECK ((int_ext = ANY (ARRAY['INT'::text, 'EXT'::text, 'INT/EXT'::text]))),
    CONSTRAINT beats_line_range_valid CHECK ((line_end >= line_start))
);


--
-- Name: camera_plates; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.camera_plates (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    shot_camera_id uuid NOT NULL,
    floor_plan_id uuid NOT NULL,
    resolved_position double precision[],
    resolved_target double precision[],
    resolved_fov double precision,
    resolved_matrix jsonb,
    image_path text,
    width integer,
    height integer,
    depth_path text,
    render_seconds double precision,
    error_message text
);


--
-- Name: TABLE camera_plates; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.camera_plates IS 'One render of one camera against one floor plan. Holds the resolved pose and the plate; a plate whose plan is not the scene''s newest is stale by definition.';


--
-- Name: camera_presets; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.camera_presets (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    movie_id uuid,
    category text NOT NULL,
    name text NOT NULL,
    instruction text NOT NULL,
    description text,
    sort_order integer DEFAULT 100 NOT NULL,
    is_builtin boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: character_images; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.character_images (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    character_id uuid NOT NULL,
    kind text NOT NULL,
    image_path text,
    seed bigint,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    version integer DEFAULT 1 NOT NULL,
    source text DEFAULT 'generated'::text NOT NULL,
    storage_key text,
    wardrobe_prop_id uuid,
    CONSTRAINT character_images_has_a_source CHECK (((image_path IS NOT NULL) OR (storage_key IS NOT NULL)))
);


--
-- Name: COLUMN character_images.wardrobe_prop_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.character_images.wardrobe_prop_id IS 'Set when this image shows the character wearing a particular costume. Used instead of the plain sheet in any shot where they wear it, which frees the reference slot the costume would have taken.';


--
-- Name: characters; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.characters (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    movie_id uuid NOT NULL,
    name text NOT NULL,
    gender text,
    visual_anchor text,
    visual_anchor_source text,
    clothing text,
    visual_descriptor text,
    lora_path text,
    lora_strength_model double precision DEFAULT 1 NOT NULL,
    lora_strength_clip double precision DEFAULT 0.31 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    face_covered boolean DEFAULT false NOT NULL,
    render_style text DEFAULT 'photographic'::text NOT NULL,
    kind text DEFAULT 'person'::text NOT NULL,
    CONSTRAINT characters_kind_check CHECK ((kind = ANY (ARRAY['person'::text, 'animal'::text, 'creature'::text, 'robot'::text, 'object'::text])))
);


--
-- Name: COLUMN characters.face_covered; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.characters.face_covered IS 'This character is never seen with an uncovered face (mask, helmet, visor). Face QA inverts: a detected face is the failure, not a low similarity score.';


--
-- Name: COLUMN characters.render_style; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.characters.render_style IS 'photographic | anime | cartoon | 3d_animated - decides the medium asserted in reference prompts.';


--
-- Name: COLUMN characters.kind; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.characters.kind IS 'What this character is: person, animal, creature, robot or object. Read by the prompt builder to decide how to introduce them and whether clothing applies. Set once; never inferred from the description.';


--
-- Name: color_palettes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.color_palettes (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    movie_id uuid,
    name text NOT NULL,
    swatches jsonb DEFAULT '[]'::jsonb NOT NULL,
    description text,
    source_path text,
    source_key text,
    is_builtin boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: director_plans; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.director_plans (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    movie_id uuid NOT NULL,
    target_seconds integer DEFAULT 120 NOT NULL,
    status text DEFAULT 'draft'::text NOT NULL,
    output_path text,
    notes text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT director_plans_status_check CHECK ((status = ANY (ARRAY['draft'::text, 'planned'::text, 'producing'::text, 'assembled'::text]))),
    CONSTRAINT director_plans_target_seconds_check CHECK (((target_seconds >= 15) AND (target_seconds <= 900)))
);


--
-- Name: director_shots; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.director_shots (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    plan_id uuid NOT NULL,
    movie_id uuid NOT NULL,
    "position" integer NOT NULL,
    scene_number integer,
    beat_id uuid,
    shot_type text,
    characters jsonb DEFAULT '[]'::jsonb NOT NULL,
    length_frames integer DEFAULT 124 NOT NULL,
    continuity text DEFAULT 'fresh'::text NOT NULL,
    frame_prompt text,
    motion_prompt text,
    first_frame_path text,
    frame_approved boolean DEFAULT false NOT NULL,
    clip_id uuid,
    status text DEFAULT 'planned'::text NOT NULL,
    notes text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    use_start_frame integer DEFAULT 0 NOT NULL,
    use_frames integer,
    shot_size text,
    foreground text,
    last_frame_path text,
    review_state text,
    review_note text,
    source text DEFAULT 'planned'::text NOT NULL,
    raw_frame text,
    raw_action text,
    review_constraint text,
    plate_path text,
    wardrobe jsonb,
    worn_text jsonb,
    CONSTRAINT director_shots_continuity_check CHECK ((continuity = ANY (ARRAY['fresh'::text, 'continue'::text]))),
    CONSTRAINT director_shots_status_check CHECK ((status = ANY (ARRAY['planned'::text, 'framing'::text, 'framed'::text, 'rendering'::text, 'rendered'::text, 'checked'::text, 'failed'::text]))),
    CONSTRAINT director_shots_use_window_sane CHECK (((use_start_frame >= 0) AND ((use_frames IS NULL) OR (use_frames >= 1))))
);


--
-- Name: COLUMN director_shots.use_start_frame; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.director_shots.use_start_frame IS 'First frame of the generated clip that reaches the cut (DIRECTOR.md 5.8).';


--
-- Name: COLUMN director_shots.use_frames; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.director_shots.use_frames IS 'How many frames reach the cut. NULL = all of them.';


--
-- Name: COLUMN director_shots.shot_size; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.director_shots.shot_size IS 'How close: wide, full, medium, medium_close, close or insert. shot_type keeps the job (establishing, dialogue, reaction, action, cutaway, insert).';


--
-- Name: COLUMN director_shots.foreground; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.director_shots.foreground IS 'One object close to the camera, in the scene already, e.g. "the metal railing". Written into the frame prompt for depth.';


--
-- Name: COLUMN director_shots.last_frame_path; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.director_shots.last_frame_path IS 'Optional final frame. With a first frame this renders first-and-last (FL2V) instead of image-to-video, so the shot lands on a known picture.';


--
-- Name: COLUMN director_shots.review_state; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.director_shots.review_state IS 'From the Review frames pass: ok | redo_frame | needs_shot | unresolved. Null means never reviewed.';


--
-- Name: COLUMN director_shots.review_note; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.director_shots.review_note IS 'Why, in plain words - what disagreed between this shot and its neighbour.';


--
-- Name: COLUMN director_shots.source; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.director_shots.source IS 'planned = drafted by the Director. inserted = added by hand or by the continuity pass.';


--
-- Name: COLUMN director_shots.raw_frame; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.director_shots.raw_frame IS 'The frame sentence as written, before character anchors, prop descriptions, the camera line and the scene light were bound into frame_prompt. Lets a prompt be rebuilt when a description changes.';


--
-- Name: COLUMN director_shots.raw_action; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.director_shots.raw_action IS 'The action sentence as written, before binding. The motion prompt is rebuilt from this.';


--
-- Name: COLUMN director_shots.review_constraint; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.director_shots.review_constraint IS 'The sentence to append to frame_prompt when repairing this shot, written by the Review frames pass. Null when there is nothing to append or the remedy is a new shot rather than a re-render.';


--
-- Name: COLUMN director_shots.plate_path; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.director_shots.plate_path IS 'The background this shot is placed on - a panorama snapshot, a splat capture, or any picture. Passed to the first-frame render as a reference, so the location is shown rather than described.';


--
-- Name: COLUMN director_shots.wardrobe; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.director_shots.wardrobe IS 'Per-shot costume assignment: [{"prop":"<movie_props id>","on":"CHARACTER"}]. NULL falls back to each costume''s worn_by. [] means nobody is wearing a costume. The wearer is per shot because a costume can change hands.';


--
-- Name: COLUMN director_shots.worn_text; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.director_shots.worn_text IS 'What the prompt actually says each character is wearing: {"a character":"the clause as written"}. Used to find and replace it when the costume changes, since the costume''s own description may have changed since.';


--
-- Name: documents; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.documents (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    movie_id uuid NOT NULL,
    kind text NOT NULL,
    character_id uuid,
    shot_kind text,
    original_filename text NOT NULL,
    storage_key text NOT NULL,
    url text,
    mime_type text,
    size_bytes bigint,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: hyworlds; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.hyworlds (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    movie_id uuid NOT NULL,
    name text NOT NULL,
    input_mode text DEFAULT 'text'::text NOT NULL,
    prompt text,
    source_path text,
    frame_cap integer DEFAULT 48 NOT NULL,
    every_nth integer DEFAULT 8 NOT NULL,
    pano_path text,
    workspace_name text,
    ply_path text,
    status text DEFAULT 'queued'::text NOT NULL,
    error_message text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    source_paths text[]
);


--
-- Name: image_edits; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.image_edits (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    movie_id uuid NOT NULL,
    prompt text NOT NULL,
    reference_paths jsonb DEFAULT '[]'::jsonb NOT NULL,
    reference_labels jsonb DEFAULT '[]'::jsonb NOT NULL,
    width integer DEFAULT 1280 NOT NULL,
    height integer DEFAULT 720 NOT NULL,
    steps integer DEFAULT 8 NOT NULL,
    seed bigint,
    status text DEFAULT 'queued'::text NOT NULL,
    output_path text,
    error_message text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    lora_name text,
    lora_strength real,
    loras jsonb DEFAULT '[]'::jsonb NOT NULL,
    engine text DEFAULT 'flux'::text NOT NULL,
    palette_id uuid,
    lighting_preset_id uuid,
    CONSTRAINT image_edits_status_check CHECK ((status = ANY (ARRAY['queued'::text, 'rendering'::text, 'complete'::text, 'failed'::text])))
);


--
-- Name: COLUMN image_edits.loras; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.image_edits.loras IS 'Ordered [{"name":"HighDetail.safetensors","strength":0.4}, ...] as chained at render time.';


--
-- Name: COLUMN image_edits.engine; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.image_edits.engine IS 'Renderer: flux (FLUX.2 Klein) or qwen (Qwen Image Edit). Existing rows are all flux.';


--
-- Name: lighting_preset_previews; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.lighting_preset_previews (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    preset_id uuid NOT NULL,
    movie_id uuid NOT NULL,
    image_path text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: lighting_presets; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.lighting_presets (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    movie_id uuid,
    name text NOT NULL,
    description text,
    instruction text NOT NULL,
    thumb_path text,
    is_builtin boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: minimax_clips; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.minimax_clips (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    movie_id uuid DEFAULT gen_random_uuid() NOT NULL,
    beat_id uuid,
    mode text NOT NULL,
    prompt text NOT NULL,
    first_image_path text,
    last_image_path text,
    width integer DEFAULT 864 NOT NULL,
    height integer DEFAULT 480 NOT NULL,
    length integer DEFAULT 124 NOT NULL,
    status text DEFAULT 'queued'::text NOT NULL,
    video_path text,
    error_message text,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    source_clip_id uuid,
    source_shot_id uuid,
    reference_image_paths jsonb DEFAULT '[]'::jsonb NOT NULL,
    use_spectrum boolean DEFAULT false NOT NULL,
    guide_end_frame integer,
    camera jsonb DEFAULT '{}'::jsonb NOT NULL,
    control_video_path text,
    control_strength double precision DEFAULT 0.7 NOT NULL,
    control_type text
);


--
-- Name: COLUMN minimax_clips.guide_end_frame; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.minimax_clips.guide_end_frame IS 'Extend only: last source frame carried into the continuation. NULL means the source''s final frame.';


--
-- Name: movie_frames; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.movie_frames (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    movie_id uuid NOT NULL,
    source_clip_id uuid,
    source_label text,
    frame_number integer,
    image_path text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: movie_props; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.movie_props (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    movie_id uuid NOT NULL,
    name text NOT NULL,
    kind text DEFAULT 'prop'::text NOT NULL,
    description text,
    scale_note text,
    image_path text,
    notes text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    aliases jsonb DEFAULT '[]'::jsonb NOT NULL,
    render_style text DEFAULT 'photographic'::text NOT NULL,
    worn_by text,
    CONSTRAINT movie_props_kind_check CHECK ((kind = ANY (ARRAY['prop'::text, 'wardrobe'::text])))
);


--
-- Name: COLUMN movie_props.aliases; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.movie_props.aliases IS 'Other words the script uses for this prop, e.g. ["crystal","wish star crystal"]. Matched longest-first so the fullest phrase wins.';


--
-- Name: COLUMN movie_props.render_style; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.movie_props.render_style IS 'anime | cartoon | animated | photographic - the prefix the sheet is rendered with. Mirrors characters.render_style.';


--
-- Name: COLUMN movie_props.worn_by; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.movie_props.worn_by IS 'For kind=wardrobe: the character who wears it, by name. The costume sheet is used as a reference in any shot that character appears in, rather than only when the text happens to name the costume.';


--
-- Name: movie_reference_images; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.movie_reference_images (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    movie_id uuid NOT NULL,
    storage_key text NOT NULL,
    original_filename text NOT NULL,
    label text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: movies; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.movies (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    title text NOT NULL,
    slug text NOT NULL,
    is_active boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    bucket_name text GENERATED ALWAYS AS (('movie-'::text || slug)) STORED,
    status text DEFAULT 'ready'::text NOT NULL,
    beats_source text DEFAULT 'generated'::text NOT NULL,
    CONSTRAINT movies_beats_source_check CHECK ((beats_source = ANY (ARRAY['generated'::text, 'authored'::text]))),
    CONSTRAINT movies_status_check CHECK ((status = ANY (ARRAY['draft'::text, 'ready'::text])))
);


--
-- Name: prompt_log; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.prompt_log (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    movie_id uuid,
    kind text NOT NULL,
    source text,
    subject_table text,
    subject_id uuid,
    "position" integer,
    scene_number integer,
    prompt text NOT NULL,
    "references" jsonb,
    settings jsonb,
    output_path text,
    comfy_prompt_id text
);


--
-- Name: TABLE prompt_log; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.prompt_log IS 'Append-only record of every final prompt sent to a renderer, with the reference order it was sent with. Never updated except to fill in output_path when the job lands.';


--
-- Name: prompt_worlds; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.prompt_worlds (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    movie_id uuid NOT NULL,
    name text NOT NULL,
    prompt text NOT NULL,
    pano_path text,
    workspace_name text,
    ply_path text,
    status text DEFAULT 'queued'::text NOT NULL,
    error_message text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: qwen_cleanups; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.qwen_cleanups (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    movie_id uuid DEFAULT gen_random_uuid() NOT NULL,
    act_number integer,
    scene_number integer,
    source_image_path text NOT NULL,
    reference_image_path text,
    reference_pano_path text,
    prompt text NOT NULL,
    status text DEFAULT 'queued'::text NOT NULL,
    cleaned_image_path text,
    error_message text,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: scene_floor_plans; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.scene_floor_plans (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    movie_id uuid NOT NULL,
    act_number integer NOT NULL,
    scene_number integer NOT NULL,
    world_name text NOT NULL,
    ply_path text NOT NULL,
    center double precision[] NOT NULL,
    up double precision[] NOT NULL,
    facing double precision[] NOT NULL,
    room_radius double precision NOT NULL,
    landmarks jsonb DEFAULT '{}'::jsonb NOT NULL,
    survey jsonb DEFAULT '{}'::jsonb NOT NULL,
    notes text
);


--
-- Name: TABLE scene_floor_plans; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.scene_floor_plans IS 'Measured geometry of one BUILD of one scene''s world: frame, room radius, and operator-named landmarks. Versioned - never updated in place, because plates reference the plan they were rendered against.';


--
-- Name: scene_panos; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.scene_panos (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    movie_id uuid NOT NULL,
    act_number integer NOT NULL,
    scene_number integer NOT NULL,
    image_path text NOT NULL,
    seed bigint,
    source text NOT NULL,
    location_derivation text,
    room_prose text,
    bad_targets jsonb DEFAULT '[]'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: scene_splats; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.scene_splats (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    movie_id uuid NOT NULL,
    act_number integer NOT NULL,
    scene_number integer NOT NULL,
    workspace_name text NOT NULL,
    ply_path text NOT NULL,
    backup_path text,
    prompt_id text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: scenes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.scenes (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    movie_id uuid NOT NULL,
    act_number integer NOT NULL,
    scene_number integer NOT NULL,
    scene_heading text,
    int_ext text,
    location_name text,
    location_description text,
    time_of_day text,
    atmosphere text,
    set_dressing text,
    sound_ambience text,
    characters_present jsonb DEFAULT '[]'::jsonb NOT NULL,
    synopsis text,
    source_hash text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    key_light text,
    screen_direction text,
    staging text,
    render_style text DEFAULT 'photographic'::text NOT NULL
);


--
-- Name: COLUMN scenes.key_light; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.scenes.key_light IS 'Direction and quality of the scene''s main light, e.g. "low golden sun from screen-left, strong rim". Used by every frame prompt in the scene.';


--
-- Name: COLUMN scenes.screen_direction; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.scenes.screen_direction IS 'What lies which way on screen, e.g. "the city is screen-left, the stairwell door is screen-right". Holds the 180-degree line across a scene.';


--
-- Name: COLUMN scenes.staging; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.scenes.staging IS 'Where the fixed things stand relative to each other, e.g. "the a vehicle is parked screen-left, nose toward the ramp; Doc stands at its open door". Written into every frame prompt in the scene.';


--
-- Name: COLUMN scenes.render_style; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.scenes.render_style IS 'anime | cartoon | animated | photographic - the look this scene''s panorama and backplates are rendered in. Mirrors characters.render_style.';


--
-- Name: score_styles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.score_styles (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    axis text NOT NULL,
    label text NOT NULL,
    descriptor text,
    bpm_min integer,
    bpm_max integer,
    quality text,
    sort_order integer DEFAULT 100 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: scores; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.scores (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    movie_id uuid NOT NULL,
    title text,
    generator text DEFAULT 'sonilo_text'::text NOT NULL,
    prompt text NOT NULL,
    duration_seconds integer DEFAULT 60 NOT NULL,
    seed bigint DEFAULT 0 NOT NULL,
    source_clip_id uuid,
    status text DEFAULT 'queued'::text NOT NULL,
    audio_path text,
    error_message text,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    source_key text,
    source_filename text,
    lyrics text,
    bpm integer,
    keyscale text,
    timesignature text,
    language text,
    reference_audio_key text,
    reference_audio_filename text,
    style_function text,
    style_mood text,
    style_arc text,
    beat_id uuid
);


--
-- Name: COLUMN scores.bpm; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.scores.bpm IS 'ACE-Step 1.5 only. NULL = parse from the caption.';


--
-- Name: COLUMN scores.keyscale; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.scores.keyscale IS 'ACE-Step 1.5 only, "<root> <major|minor>". NULL = parse from the caption.';


--
-- Name: COLUMN scores.timesignature; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.scores.timesignature IS 'ACE-Step 1.5 only, one of 2/3/4/6. NULL = parse from the caption.';


--
-- Name: COLUMN scores.language; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.scores.language IS 'ACE-Step 1.5 only, ISO code for the lyrics. NULL = en.';


--
-- Name: COLUMN scores.reference_audio_key; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.scores.reference_audio_key IS 'ACE-Step 1.5 only: storage key of a track whose timbre the cue should follow.';


--
-- Name: screenplay_chunks; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.screenplay_chunks (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    movie_id uuid NOT NULL,
    idx integer NOT NULL,
    label text NOT NULL,
    source_text text NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    proposal jsonb,
    error_message text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT screenplay_chunks_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'running'::text, 'proposed'::text, 'accepted'::text, 'skipped'::text, 'failed'::text])))
);


--
-- Name: shot_cameras; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.shot_cameras (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    shot_id uuid NOT NULL,
    label text,
    is_chosen boolean DEFAULT false NOT NULL,
    from_landmark text,
    look_at_landmark text NOT NULL,
    distance_frac double precision DEFAULT 0.38 NOT NULL,
    offset_frac double precision DEFAULT 0.0 NOT NULL,
    eye_height_frac double precision DEFAULT 0.09 NOT NULL,
    aim_height_frac double precision DEFAULT 0.09 NOT NULL,
    fov_deg double precision DEFAULT 45 NOT NULL,
    line_side_landmark text,
    keyframes jsonb DEFAULT '[]'::jsonb NOT NULL,
    explicit_pose jsonb,
    explicit_world text,
    is_manual boolean DEFAULT false NOT NULL,
    aim_side_frac double precision DEFAULT 0 NOT NULL
);


--
-- Name: TABLE shot_cameras; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.shot_cameras IS 'A shot''s camera as INTENT - landmarks, fractions of room radius, lens - so it survives a world rebuild. explicit_pose is the escape hatch for a hand-flown angle and is pinned to its world.';


--
-- Name: COLUMN shot_cameras.aim_side_frac; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.shot_cameras.aim_side_frac IS 'How far to one side of the landmark the camera aims, as a fraction of the room radius. Positive is toward cross(up, landmark direction). With aim_height_frac this gives the aim both of its degrees of freedom, so any flown angle can be written down exactly.';


--
-- Name: shots; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.shots (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    movie_id uuid NOT NULL,
    beat_id uuid NOT NULL,
    act_number integer NOT NULL,
    scene_number integer NOT NULL,
    reference_character_image_ids jsonb DEFAULT '[]'::jsonb NOT NULL,
    raw_capture_path text,
    cleaned_image_path text,
    prompt_text text,
    status text DEFAULT 'awaiting_cleanup'::text NOT NULL,
    error_message text,
    video_path text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    parent_shot_id uuid,
    length_frames integer,
    extra_reference_paths jsonb DEFAULT '[]'::jsonb NOT NULL,
    CONSTRAINT shots_status_check CHECK ((status = ANY (ARRAY['awaiting_cleanup'::text, 'cleaned'::text, 'ready'::text, 'rendering'::text, 'complete'::text, 'failed'::text])))
);


--
-- Name: voice_replacements; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.voice_replacements (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    movie_id uuid NOT NULL,
    clip_id uuid,
    voice_id text NOT NULL,
    voice_name text,
    gain real DEFAULT 2.0 NOT NULL,
    status text DEFAULT 'queued'::text NOT NULL,
    output_path text,
    vocal_path text,
    bed_path text,
    timing_match real,
    error_message text,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    source_key text,
    source_filename text
);


--
-- Name: beats beats_movie_act_scene_beat_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.beats
    ADD CONSTRAINT beats_movie_act_scene_beat_unique UNIQUE (movie_id, act_number, scene_number, beat_number) DEFERRABLE;


--
-- Name: beats beats_movie_sequence_index_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.beats
    ADD CONSTRAINT beats_movie_sequence_index_unique UNIQUE (movie_id, sequence_index) DEFERRABLE;


--
-- Name: beats beats_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.beats
    ADD CONSTRAINT beats_pkey PRIMARY KEY (id);


--
-- Name: camera_plates camera_plates_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.camera_plates
    ADD CONSTRAINT camera_plates_pkey PRIMARY KEY (id);


--
-- Name: camera_presets camera_presets_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.camera_presets
    ADD CONSTRAINT camera_presets_pkey PRIMARY KEY (id);


--
-- Name: character_images character_images_character_kind_version_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.character_images
    ADD CONSTRAINT character_images_character_kind_version_unique UNIQUE (character_id, kind, version);


--
-- Name: character_images character_images_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.character_images
    ADD CONSTRAINT character_images_pkey PRIMARY KEY (id);


--
-- Name: characters characters_movie_name_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.characters
    ADD CONSTRAINT characters_movie_name_unique UNIQUE (movie_id, name);


--
-- Name: characters characters_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.characters
    ADD CONSTRAINT characters_pkey PRIMARY KEY (id);


--
-- Name: color_palettes color_palettes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.color_palettes
    ADD CONSTRAINT color_palettes_pkey PRIMARY KEY (id);


--
-- Name: director_plans director_plans_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.director_plans
    ADD CONSTRAINT director_plans_pkey PRIMARY KEY (id);


--
-- Name: director_shots director_shots_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.director_shots
    ADD CONSTRAINT director_shots_pkey PRIMARY KEY (id);


--
-- Name: director_shots director_shots_plan_id_position_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.director_shots
    ADD CONSTRAINT director_shots_plan_id_position_key UNIQUE (plan_id, "position");


--
-- Name: documents documents_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.documents
    ADD CONSTRAINT documents_pkey PRIMARY KEY (id);


--
-- Name: hyworlds hyworlds_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hyworlds
    ADD CONSTRAINT hyworlds_pkey PRIMARY KEY (id);


--
-- Name: image_edits image_edits_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.image_edits
    ADD CONSTRAINT image_edits_pkey PRIMARY KEY (id);


--
-- Name: lighting_preset_previews lighting_preset_previews_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.lighting_preset_previews
    ADD CONSTRAINT lighting_preset_previews_pkey PRIMARY KEY (id);


--
-- Name: lighting_preset_previews lighting_preset_previews_preset_id_movie_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.lighting_preset_previews
    ADD CONSTRAINT lighting_preset_previews_preset_id_movie_id_key UNIQUE (preset_id, movie_id);


--
-- Name: lighting_presets lighting_presets_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.lighting_presets
    ADD CONSTRAINT lighting_presets_pkey PRIMARY KEY (id);


--
-- Name: minimax_clips minimax_clips_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.minimax_clips
    ADD CONSTRAINT minimax_clips_pkey PRIMARY KEY (id);


--
-- Name: movie_frames movie_frames_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.movie_frames
    ADD CONSTRAINT movie_frames_pkey PRIMARY KEY (id);


--
-- Name: movie_props movie_props_movie_id_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.movie_props
    ADD CONSTRAINT movie_props_movie_id_name_key UNIQUE (movie_id, name);


--
-- Name: movie_props movie_props_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.movie_props
    ADD CONSTRAINT movie_props_pkey PRIMARY KEY (id);


--
-- Name: movie_reference_images movie_reference_images_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.movie_reference_images
    ADD CONSTRAINT movie_reference_images_pkey PRIMARY KEY (id);


--
-- Name: movies movies_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.movies
    ADD CONSTRAINT movies_pkey PRIMARY KEY (id);


--
-- Name: movies movies_slug_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.movies
    ADD CONSTRAINT movies_slug_key UNIQUE (slug);


--
-- Name: prompt_log prompt_log_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.prompt_log
    ADD CONSTRAINT prompt_log_pkey PRIMARY KEY (id);


--
-- Name: prompt_worlds prompt_worlds_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.prompt_worlds
    ADD CONSTRAINT prompt_worlds_pkey PRIMARY KEY (id);


--
-- Name: qwen_cleanups qwen_cleanups_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.qwen_cleanups
    ADD CONSTRAINT qwen_cleanups_pkey PRIMARY KEY (id);


--
-- Name: scene_floor_plans scene_floor_plans_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.scene_floor_plans
    ADD CONSTRAINT scene_floor_plans_pkey PRIMARY KEY (id);


--
-- Name: scene_panos scene_panos_movie_act_scene_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.scene_panos
    ADD CONSTRAINT scene_panos_movie_act_scene_unique UNIQUE (movie_id, act_number, scene_number);


--
-- Name: scene_panos scene_panos_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.scene_panos
    ADD CONSTRAINT scene_panos_pkey PRIMARY KEY (id);


--
-- Name: scene_splats scene_splats_movie_act_scene_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.scene_splats
    ADD CONSTRAINT scene_splats_movie_act_scene_unique UNIQUE (movie_id, act_number, scene_number);


--
-- Name: scene_splats scene_splats_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.scene_splats
    ADD CONSTRAINT scene_splats_pkey PRIMARY KEY (id);


--
-- Name: scenes scenes_movie_id_act_number_scene_number_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.scenes
    ADD CONSTRAINT scenes_movie_id_act_number_scene_number_key UNIQUE (movie_id, act_number, scene_number);


--
-- Name: scenes scenes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.scenes
    ADD CONSTRAINT scenes_pkey PRIMARY KEY (id);


--
-- Name: score_styles score_styles_axis_label_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.score_styles
    ADD CONSTRAINT score_styles_axis_label_key UNIQUE (axis, label);


--
-- Name: score_styles score_styles_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.score_styles
    ADD CONSTRAINT score_styles_pkey PRIMARY KEY (id);


--
-- Name: scores scores_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.scores
    ADD CONSTRAINT scores_pkey PRIMARY KEY (id);


--
-- Name: screenplay_chunks screenplay_chunks_movie_idx_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.screenplay_chunks
    ADD CONSTRAINT screenplay_chunks_movie_idx_unique UNIQUE (movie_id, idx);


--
-- Name: screenplay_chunks screenplay_chunks_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.screenplay_chunks
    ADD CONSTRAINT screenplay_chunks_pkey PRIMARY KEY (id);


--
-- Name: shot_cameras shot_cameras_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.shot_cameras
    ADD CONSTRAINT shot_cameras_pkey PRIMARY KEY (id);


--
-- Name: shots shots_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.shots
    ADD CONSTRAINT shots_pkey PRIMARY KEY (id);


--
-- Name: voice_replacements voice_replacements_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.voice_replacements
    ADD CONSTRAINT voice_replacements_pkey PRIMARY KEY (id);


--
-- Name: idx_beats_movie_act_number; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_beats_movie_act_number ON public.beats USING btree (movie_id, act_number);


--
-- Name: idx_beats_movie_act_scene; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_beats_movie_act_scene ON public.beats USING btree (movie_id, act_number, scene_number);


--
-- Name: idx_beats_movie_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_beats_movie_id ON public.beats USING btree (movie_id);


--
-- Name: idx_beats_source_hash; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_beats_source_hash ON public.beats USING btree (movie_id, act_number, scene_number, source_hash);


--
-- Name: idx_camera_plates_camera; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_camera_plates_camera ON public.camera_plates USING btree (shot_camera_id, created_at DESC);


--
-- Name: idx_camera_plates_plan; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_camera_plates_plan ON public.camera_plates USING btree (floor_plan_id);


--
-- Name: idx_camera_presets_cat; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_camera_presets_cat ON public.camera_presets USING btree (category, sort_order, name);


--
-- Name: idx_character_images_char_version; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_character_images_char_version ON public.character_images USING btree (character_id, version);


--
-- Name: idx_character_images_character_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_character_images_character_id ON public.character_images USING btree (character_id);


--
-- Name: idx_character_images_wardrobe; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_character_images_wardrobe ON public.character_images USING btree (character_id, wardrobe_prop_id) WHERE (wardrobe_prop_id IS NOT NULL);


--
-- Name: idx_characters_movie_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_characters_movie_id ON public.characters USING btree (movie_id);


--
-- Name: idx_color_palettes_movie; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_color_palettes_movie ON public.color_palettes USING btree (movie_id, created_at DESC);


--
-- Name: idx_director_plans_movie; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_director_plans_movie ON public.director_plans USING btree (movie_id, created_at DESC);


--
-- Name: idx_director_shots_plan; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_director_shots_plan ON public.director_shots USING btree (plan_id, "position");


--
-- Name: idx_documents_movie_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_documents_movie_id ON public.documents USING btree (movie_id);


--
-- Name: idx_documents_movie_kind; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_documents_movie_kind ON public.documents USING btree (movie_id, kind);


--
-- Name: idx_floor_plans_scene; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_floor_plans_scene ON public.scene_floor_plans USING btree (movie_id, act_number, scene_number, created_at DESC);


--
-- Name: idx_hyworlds_movie; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_hyworlds_movie ON public.hyworlds USING btree (movie_id, created_at DESC);


--
-- Name: idx_image_edits_movie; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_image_edits_movie ON public.image_edits USING btree (movie_id, created_at DESC);


--
-- Name: idx_lighting_preset_previews_movie; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_lighting_preset_previews_movie ON public.lighting_preset_previews USING btree (movie_id);


--
-- Name: idx_lighting_presets_movie; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_lighting_presets_movie ON public.lighting_presets USING btree (movie_id, created_at DESC);


--
-- Name: idx_movie_frames_movie; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_movie_frames_movie ON public.movie_frames USING btree (movie_id, created_at DESC);


--
-- Name: idx_movie_props_movie; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_movie_props_movie ON public.movie_props USING btree (movie_id, kind, name);


--
-- Name: idx_movie_reference_images_movie; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_movie_reference_images_movie ON public.movie_reference_images USING btree (movie_id);


--
-- Name: idx_movies_single_active; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_movies_single_active ON public.movies USING btree (is_active) WHERE is_active;


--
-- Name: idx_prompt_log_movie_time; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_prompt_log_movie_time ON public.prompt_log USING btree (movie_id, created_at DESC);


--
-- Name: idx_prompt_log_subject; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_prompt_log_subject ON public.prompt_log USING btree (subject_table, subject_id, created_at DESC);


--
-- Name: idx_prompt_worlds_movie; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_prompt_worlds_movie ON public.prompt_worlds USING btree (movie_id, created_at DESC);


--
-- Name: idx_scene_panos_movie_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_scene_panos_movie_id ON public.scene_panos USING btree (movie_id);


--
-- Name: idx_scene_splats_movie_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_scene_splats_movie_id ON public.scene_splats USING btree (movie_id);


--
-- Name: idx_score_styles_axis; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_score_styles_axis ON public.score_styles USING btree (axis, sort_order);


--
-- Name: idx_screenplay_chunks_movie_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_screenplay_chunks_movie_id ON public.screenplay_chunks USING btree (movie_id);


--
-- Name: idx_shot_cameras_one_chosen; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_shot_cameras_one_chosen ON public.shot_cameras USING btree (shot_id) WHERE is_chosen;


--
-- Name: idx_shot_cameras_shot; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_shot_cameras_shot ON public.shot_cameras USING btree (shot_id, is_chosen DESC, created_at DESC);


--
-- Name: idx_shots_beat_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_shots_beat_id ON public.shots USING btree (beat_id);


--
-- Name: idx_shots_movie_scene; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_shots_movie_scene ON public.shots USING btree (movie_id, act_number, scene_number);


--
-- Name: image_edits image_edits_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER image_edits_updated_at BEFORE UPDATE ON public.image_edits FOR EACH ROW EXECUTE FUNCTION system.update_updated_at();


--
-- Name: minimax_clips minimax_clips_update_timestamp; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER minimax_clips_update_timestamp BEFORE UPDATE ON public.minimax_clips FOR EACH ROW EXECUTE FUNCTION system.update_updated_at();


--
-- Name: qwen_cleanups qwen_cleanups_update_timestamp; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER qwen_cleanups_update_timestamp BEFORE UPDATE ON public.qwen_cleanups FOR EACH ROW EXECUTE FUNCTION system.update_updated_at();


--
-- Name: screenplay_chunks screenplay_chunks_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER screenplay_chunks_updated_at BEFORE UPDATE ON public.screenplay_chunks FOR EACH ROW EXECUTE FUNCTION system.update_updated_at();


--
-- Name: shots shots_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER shots_updated_at BEFORE UPDATE ON public.shots FOR EACH ROW EXECUTE FUNCTION system.update_updated_at();


--
-- Name: beats beats_movie_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.beats
    ADD CONSTRAINT beats_movie_id_fkey FOREIGN KEY (movie_id) REFERENCES public.movies(id) ON DELETE CASCADE;


--
-- Name: camera_plates camera_plates_floor_plan_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.camera_plates
    ADD CONSTRAINT camera_plates_floor_plan_id_fkey FOREIGN KEY (floor_plan_id) REFERENCES public.scene_floor_plans(id) ON DELETE CASCADE;


--
-- Name: camera_plates camera_plates_shot_camera_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.camera_plates
    ADD CONSTRAINT camera_plates_shot_camera_id_fkey FOREIGN KEY (shot_camera_id) REFERENCES public.shot_cameras(id) ON DELETE CASCADE;


--
-- Name: camera_presets camera_presets_movie_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.camera_presets
    ADD CONSTRAINT camera_presets_movie_id_fkey FOREIGN KEY (movie_id) REFERENCES public.movies(id) ON DELETE CASCADE;


--
-- Name: character_images character_images_character_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.character_images
    ADD CONSTRAINT character_images_character_id_fkey FOREIGN KEY (character_id) REFERENCES public.characters(id) ON DELETE CASCADE;


--
-- Name: character_images character_images_wardrobe_prop_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.character_images
    ADD CONSTRAINT character_images_wardrobe_prop_id_fkey FOREIGN KEY (wardrobe_prop_id) REFERENCES public.movie_props(id) ON DELETE CASCADE;


--
-- Name: characters characters_movie_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.characters
    ADD CONSTRAINT characters_movie_id_fkey FOREIGN KEY (movie_id) REFERENCES public.movies(id) ON DELETE CASCADE;


--
-- Name: color_palettes color_palettes_movie_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.color_palettes
    ADD CONSTRAINT color_palettes_movie_id_fkey FOREIGN KEY (movie_id) REFERENCES public.movies(id) ON DELETE CASCADE;


--
-- Name: director_plans director_plans_movie_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.director_plans
    ADD CONSTRAINT director_plans_movie_id_fkey FOREIGN KEY (movie_id) REFERENCES public.movies(id) ON DELETE CASCADE;


--
-- Name: director_shots director_shots_beat_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.director_shots
    ADD CONSTRAINT director_shots_beat_id_fkey FOREIGN KEY (beat_id) REFERENCES public.beats(id) ON DELETE SET NULL;


--
-- Name: director_shots director_shots_clip_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.director_shots
    ADD CONSTRAINT director_shots_clip_id_fkey FOREIGN KEY (clip_id) REFERENCES public.minimax_clips(id) ON DELETE SET NULL;


--
-- Name: director_shots director_shots_movie_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.director_shots
    ADD CONSTRAINT director_shots_movie_id_fkey FOREIGN KEY (movie_id) REFERENCES public.movies(id) ON DELETE CASCADE;


--
-- Name: director_shots director_shots_plan_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.director_shots
    ADD CONSTRAINT director_shots_plan_id_fkey FOREIGN KEY (plan_id) REFERENCES public.director_plans(id) ON DELETE CASCADE;


--
-- Name: documents documents_movie_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.documents
    ADD CONSTRAINT documents_movie_id_fkey FOREIGN KEY (movie_id) REFERENCES public.movies(id) ON DELETE CASCADE;


--
-- Name: hyworlds hyworlds_movie_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hyworlds
    ADD CONSTRAINT hyworlds_movie_id_fkey FOREIGN KEY (movie_id) REFERENCES public.movies(id) ON DELETE CASCADE;


--
-- Name: image_edits image_edits_movie_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.image_edits
    ADD CONSTRAINT image_edits_movie_id_fkey FOREIGN KEY (movie_id) REFERENCES public.movies(id) ON DELETE CASCADE;


--
-- Name: lighting_preset_previews lighting_preset_previews_movie_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.lighting_preset_previews
    ADD CONSTRAINT lighting_preset_previews_movie_id_fkey FOREIGN KEY (movie_id) REFERENCES public.movies(id) ON DELETE CASCADE;


--
-- Name: lighting_preset_previews lighting_preset_previews_preset_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.lighting_preset_previews
    ADD CONSTRAINT lighting_preset_previews_preset_id_fkey FOREIGN KEY (preset_id) REFERENCES public.lighting_presets(id) ON DELETE CASCADE;


--
-- Name: lighting_presets lighting_presets_movie_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.lighting_presets
    ADD CONSTRAINT lighting_presets_movie_id_fkey FOREIGN KEY (movie_id) REFERENCES public.movies(id) ON DELETE CASCADE;


--
-- Name: minimax_clips minimax_clips_source_clip_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.minimax_clips
    ADD CONSTRAINT minimax_clips_source_clip_id_fkey FOREIGN KEY (source_clip_id) REFERENCES public.minimax_clips(id) ON DELETE SET NULL;


--
-- Name: minimax_clips minimax_clips_source_shot_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.minimax_clips
    ADD CONSTRAINT minimax_clips_source_shot_id_fkey FOREIGN KEY (source_shot_id) REFERENCES public.shots(id) ON DELETE SET NULL;


--
-- Name: movie_frames movie_frames_movie_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.movie_frames
    ADD CONSTRAINT movie_frames_movie_id_fkey FOREIGN KEY (movie_id) REFERENCES public.movies(id) ON DELETE CASCADE;


--
-- Name: movie_props movie_props_movie_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.movie_props
    ADD CONSTRAINT movie_props_movie_id_fkey FOREIGN KEY (movie_id) REFERENCES public.movies(id) ON DELETE CASCADE;


--
-- Name: movie_reference_images movie_reference_images_movie_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.movie_reference_images
    ADD CONSTRAINT movie_reference_images_movie_id_fkey FOREIGN KEY (movie_id) REFERENCES public.movies(id) ON DELETE CASCADE;


--
-- Name: prompt_log prompt_log_movie_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.prompt_log
    ADD CONSTRAINT prompt_log_movie_id_fkey FOREIGN KEY (movie_id) REFERENCES public.movies(id) ON DELETE CASCADE;


--
-- Name: prompt_worlds prompt_worlds_movie_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.prompt_worlds
    ADD CONSTRAINT prompt_worlds_movie_id_fkey FOREIGN KEY (movie_id) REFERENCES public.movies(id) ON DELETE CASCADE;


--
-- Name: scene_floor_plans scene_floor_plans_movie_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.scene_floor_plans
    ADD CONSTRAINT scene_floor_plans_movie_id_fkey FOREIGN KEY (movie_id) REFERENCES public.movies(id) ON DELETE CASCADE;


--
-- Name: scene_panos scene_panos_movie_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.scene_panos
    ADD CONSTRAINT scene_panos_movie_id_fkey FOREIGN KEY (movie_id) REFERENCES public.movies(id) ON DELETE CASCADE;


--
-- Name: scene_splats scene_splats_movie_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.scene_splats
    ADD CONSTRAINT scene_splats_movie_id_fkey FOREIGN KEY (movie_id) REFERENCES public.movies(id) ON DELETE CASCADE;


--
-- Name: scenes scenes_movie_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.scenes
    ADD CONSTRAINT scenes_movie_id_fkey FOREIGN KEY (movie_id) REFERENCES public.movies(id) ON DELETE CASCADE;


--
-- Name: scores scores_movie_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.scores
    ADD CONSTRAINT scores_movie_id_fkey FOREIGN KEY (movie_id) REFERENCES public.movies(id) ON DELETE CASCADE;


--
-- Name: scores scores_source_clip_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.scores
    ADD CONSTRAINT scores_source_clip_id_fkey FOREIGN KEY (source_clip_id) REFERENCES public.minimax_clips(id) ON DELETE SET NULL;


--
-- Name: screenplay_chunks screenplay_chunks_movie_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.screenplay_chunks
    ADD CONSTRAINT screenplay_chunks_movie_id_fkey FOREIGN KEY (movie_id) REFERENCES public.movies(id) ON DELETE CASCADE;


--
-- Name: shot_cameras shot_cameras_shot_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.shot_cameras
    ADD CONSTRAINT shot_cameras_shot_id_fkey FOREIGN KEY (shot_id) REFERENCES public.director_shots(id) ON DELETE CASCADE;


--
-- Name: shots shots_beat_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.shots
    ADD CONSTRAINT shots_beat_id_fkey FOREIGN KEY (beat_id) REFERENCES public.beats(id);


--
-- Name: shots shots_movie_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.shots
    ADD CONSTRAINT shots_movie_id_fkey FOREIGN KEY (movie_id) REFERENCES public.movies(id);


--
-- Name: voice_replacements voice_replacements_clip_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.voice_replacements
    ADD CONSTRAINT voice_replacements_clip_id_fkey FOREIGN KEY (clip_id) REFERENCES public.minimax_clips(id) ON DELETE CASCADE;


--
-- Name: voice_replacements voice_replacements_movie_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.voice_replacements
    ADD CONSTRAINT voice_replacements_movie_id_fkey FOREIGN KEY (movie_id) REFERENCES public.movies(id) ON DELETE CASCADE;


--
-- Name: beats admin app full access; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "admin app full access" ON public.beats TO anon, authenticated USING (true) WITH CHECK (true);


--
-- Name: camera_plates admin app full access; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "admin app full access" ON public.camera_plates TO anon, authenticated USING (true) WITH CHECK (true);


--
-- Name: camera_presets admin app full access; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "admin app full access" ON public.camera_presets TO anon, authenticated USING (true) WITH CHECK (true);


--
-- Name: character_images admin app full access; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "admin app full access" ON public.character_images TO anon, authenticated USING (true) WITH CHECK (true);


--
-- Name: characters admin app full access; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "admin app full access" ON public.characters TO anon, authenticated USING (true) WITH CHECK (true);


--
-- Name: color_palettes admin app full access; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "admin app full access" ON public.color_palettes TO anon, authenticated USING (true) WITH CHECK (true);


--
-- Name: director_plans admin app full access; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "admin app full access" ON public.director_plans TO anon, authenticated USING (true) WITH CHECK (true);


--
-- Name: director_shots admin app full access; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "admin app full access" ON public.director_shots TO anon, authenticated USING (true) WITH CHECK (true);


--
-- Name: documents admin app full access; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "admin app full access" ON public.documents TO anon, authenticated USING (true) WITH CHECK (true);


--
-- Name: hyworlds admin app full access; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "admin app full access" ON public.hyworlds TO anon, authenticated USING (true) WITH CHECK (true);


--
-- Name: image_edits admin app full access; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "admin app full access" ON public.image_edits TO anon, authenticated USING (true) WITH CHECK (true);


--
-- Name: lighting_preset_previews admin app full access; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "admin app full access" ON public.lighting_preset_previews TO anon, authenticated USING (true) WITH CHECK (true);


--
-- Name: lighting_presets admin app full access; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "admin app full access" ON public.lighting_presets TO anon, authenticated USING (true) WITH CHECK (true);


--
-- Name: minimax_clips admin app full access; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "admin app full access" ON public.minimax_clips TO anon, authenticated USING (true) WITH CHECK (true);


--
-- Name: movie_frames admin app full access; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "admin app full access" ON public.movie_frames TO anon, authenticated USING (true) WITH CHECK (true);


--
-- Name: movie_props admin app full access; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "admin app full access" ON public.movie_props TO anon, authenticated USING (true) WITH CHECK (true);


--
-- Name: movie_reference_images admin app full access; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "admin app full access" ON public.movie_reference_images TO anon, authenticated USING (true) WITH CHECK (true);


--
-- Name: prompt_log admin app full access; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "admin app full access" ON public.prompt_log TO anon, authenticated USING (true) WITH CHECK (true);


--
-- Name: prompt_worlds admin app full access; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "admin app full access" ON public.prompt_worlds TO anon, authenticated USING (true) WITH CHECK (true);


--
-- Name: qwen_cleanups admin app full access; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "admin app full access" ON public.qwen_cleanups TO anon, authenticated USING (true) WITH CHECK (true);


--
-- Name: scene_floor_plans admin app full access; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "admin app full access" ON public.scene_floor_plans TO anon, authenticated USING (true) WITH CHECK (true);


--
-- Name: scene_panos admin app full access; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "admin app full access" ON public.scene_panos TO anon, authenticated USING (true) WITH CHECK (true);


--
-- Name: scene_splats admin app full access; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "admin app full access" ON public.scene_splats TO anon, authenticated USING (true) WITH CHECK (true);


--
-- Name: score_styles admin app full access; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "admin app full access" ON public.score_styles TO anon, authenticated USING (true) WITH CHECK (true);


--
-- Name: scores admin app full access; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "admin app full access" ON public.scores TO anon, authenticated USING (true) WITH CHECK (true);


--
-- Name: screenplay_chunks admin app full access; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "admin app full access" ON public.screenplay_chunks TO anon, authenticated USING (true) WITH CHECK (true);


--
-- Name: shot_cameras admin app full access; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "admin app full access" ON public.shot_cameras TO anon, authenticated USING (true) WITH CHECK (true);


--
-- Name: shots admin app full access; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "admin app full access" ON public.shots TO anon, authenticated USING (true) WITH CHECK (true);


--
-- Name: voice_replacements admin app full access; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "admin app full access" ON public.voice_replacements TO anon, authenticated USING (true) WITH CHECK (true);


--
-- Name: beats; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.beats ENABLE ROW LEVEL SECURITY;

--
-- Name: camera_plates; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.camera_plates ENABLE ROW LEVEL SECURITY;

--
-- Name: camera_presets; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.camera_presets ENABLE ROW LEVEL SECURITY;

--
-- Name: character_images; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.character_images ENABLE ROW LEVEL SECURITY;

--
-- Name: characters; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.characters ENABLE ROW LEVEL SECURITY;

--
-- Name: color_palettes; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.color_palettes ENABLE ROW LEVEL SECURITY;

--
-- Name: director_plans; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.director_plans ENABLE ROW LEVEL SECURITY;

--
-- Name: director_shots; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.director_shots ENABLE ROW LEVEL SECURITY;

--
-- Name: documents; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.documents ENABLE ROW LEVEL SECURITY;

--
-- Name: hyworlds; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.hyworlds ENABLE ROW LEVEL SECURITY;

--
-- Name: image_edits; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.image_edits ENABLE ROW LEVEL SECURITY;

--
-- Name: lighting_preset_previews; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.lighting_preset_previews ENABLE ROW LEVEL SECURITY;

--
-- Name: lighting_presets; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.lighting_presets ENABLE ROW LEVEL SECURITY;

--
-- Name: minimax_clips; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.minimax_clips ENABLE ROW LEVEL SECURITY;

--
-- Name: movie_frames; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.movie_frames ENABLE ROW LEVEL SECURITY;

--
-- Name: movie_props; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.movie_props ENABLE ROW LEVEL SECURITY;

--
-- Name: movie_reference_images; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.movie_reference_images ENABLE ROW LEVEL SECURITY;

--
-- Name: prompt_log; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.prompt_log ENABLE ROW LEVEL SECURITY;

--
-- Name: prompt_worlds; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.prompt_worlds ENABLE ROW LEVEL SECURITY;

--
-- Name: qwen_cleanups; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.qwen_cleanups ENABLE ROW LEVEL SECURITY;

--
-- Name: scene_floor_plans; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.scene_floor_plans ENABLE ROW LEVEL SECURITY;

--
-- Name: scene_panos; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.scene_panos ENABLE ROW LEVEL SECURITY;

--
-- Name: scene_splats; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.scene_splats ENABLE ROW LEVEL SECURITY;

--
-- Name: score_styles; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.score_styles ENABLE ROW LEVEL SECURITY;

--
-- Name: scores; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.scores ENABLE ROW LEVEL SECURITY;

--
-- Name: screenplay_chunks; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.screenplay_chunks ENABLE ROW LEVEL SECURITY;

--
-- Name: shot_cameras; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.shot_cameras ENABLE ROW LEVEL SECURITY;

--
-- Name: shots; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.shots ENABLE ROW LEVEL SECURITY;

--
-- Name: voice_replacements; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.voice_replacements ENABLE ROW LEVEL SECURITY;

--
-- PostgreSQL database dump complete
--

\unrestrict jrZ5CfmcVAtLOJMIKu1nBYdWcr1xVsrO1ELH88j1cxyzpHcXVRxWi0JPhL2lx7e

