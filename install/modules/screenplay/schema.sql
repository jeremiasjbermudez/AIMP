-- Screenplay & structure
-- Tables: scenes, beats, screenplay_chunks, documents
--
-- Replayed by install/install-module.ps1. Safe to run twice: every
-- statement is guarded, and the installer stops on the first real error.

--
-- Name: beats; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.beats (
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
-- Name: documents; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.documents (
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
-- Name: scenes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.scenes (
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
-- Name: screenplay_chunks; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.screenplay_chunks (
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
-- Name: beats beats_movie_act_scene_beat_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $guard$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'beats_movie_act_scene_beat_unique'
                     AND conrelid = 'public.beats'::regclass) THEN
        ALTER TABLE ONLY public.beats ADD CONSTRAINT beats_movie_act_scene_beat_unique UNIQUE (movie_id, act_number, scene_number, beat_number) DEFERRABLE;
    END IF;
END $guard$;

--
-- Name: beats beats_movie_sequence_index_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $guard$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'beats_movie_sequence_index_unique'
                     AND conrelid = 'public.beats'::regclass) THEN
        ALTER TABLE ONLY public.beats ADD CONSTRAINT beats_movie_sequence_index_unique UNIQUE (movie_id, sequence_index) DEFERRABLE;
    END IF;
END $guard$;

--
-- Name: beats beats_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $guard$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'beats_pkey'
                     AND conrelid = 'public.beats'::regclass) THEN
        ALTER TABLE ONLY public.beats ADD CONSTRAINT beats_pkey PRIMARY KEY (id);
    END IF;
END $guard$;

--
-- Name: documents documents_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $guard$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'documents_pkey'
                     AND conrelid = 'public.documents'::regclass) THEN
        ALTER TABLE ONLY public.documents ADD CONSTRAINT documents_pkey PRIMARY KEY (id);
    END IF;
END $guard$;

--
-- Name: scenes scenes_movie_id_act_number_scene_number_key; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $guard$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'scenes_movie_id_act_number_scene_number_key'
                     AND conrelid = 'public.scenes'::regclass) THEN
        ALTER TABLE ONLY public.scenes ADD CONSTRAINT scenes_movie_id_act_number_scene_number_key UNIQUE (movie_id, act_number, scene_number);
    END IF;
END $guard$;

--
-- Name: scenes scenes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $guard$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'scenes_pkey'
                     AND conrelid = 'public.scenes'::regclass) THEN
        ALTER TABLE ONLY public.scenes ADD CONSTRAINT scenes_pkey PRIMARY KEY (id);
    END IF;
END $guard$;

--
-- Name: screenplay_chunks screenplay_chunks_movie_idx_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $guard$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'screenplay_chunks_movie_idx_unique'
                     AND conrelid = 'public.screenplay_chunks'::regclass) THEN
        ALTER TABLE ONLY public.screenplay_chunks ADD CONSTRAINT screenplay_chunks_movie_idx_unique UNIQUE (movie_id, idx);
    END IF;
END $guard$;

--
-- Name: screenplay_chunks screenplay_chunks_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $guard$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'screenplay_chunks_pkey'
                     AND conrelid = 'public.screenplay_chunks'::regclass) THEN
        ALTER TABLE ONLY public.screenplay_chunks ADD CONSTRAINT screenplay_chunks_pkey PRIMARY KEY (id);
    END IF;
END $guard$;

--
-- Name: idx_beats_movie_act_number; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS idx_beats_movie_act_number ON public.beats USING btree (movie_id, act_number);

--
-- Name: idx_beats_movie_act_scene; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS idx_beats_movie_act_scene ON public.beats USING btree (movie_id, act_number, scene_number);

--
-- Name: idx_beats_movie_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS idx_beats_movie_id ON public.beats USING btree (movie_id);

--
-- Name: idx_beats_source_hash; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS idx_beats_source_hash ON public.beats USING btree (movie_id, act_number, scene_number, source_hash);

--
-- Name: idx_documents_movie_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS idx_documents_movie_id ON public.documents USING btree (movie_id);

--
-- Name: idx_documents_movie_kind; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS idx_documents_movie_kind ON public.documents USING btree (movie_id, kind);

--
-- Name: idx_screenplay_chunks_movie_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS idx_screenplay_chunks_movie_id ON public.screenplay_chunks USING btree (movie_id);

--
-- Name: screenplay_chunks screenplay_chunks_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

DROP TRIGGER IF EXISTS screenplay_chunks_updated_at ON public.screenplay_chunks;
CREATE TRIGGER screenplay_chunks_updated_at BEFORE UPDATE ON public.screenplay_chunks FOR EACH ROW EXECUTE FUNCTION system.update_updated_at();

--
-- Name: beats beats_movie_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $guard$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'beats_movie_id_fkey'
                     AND conrelid = 'public.beats'::regclass) THEN
        ALTER TABLE ONLY public.beats ADD CONSTRAINT beats_movie_id_fkey FOREIGN KEY (movie_id) REFERENCES public.movies(id) ON DELETE CASCADE;
    END IF;
END $guard$;

--
-- Name: documents documents_movie_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $guard$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'documents_movie_id_fkey'
                     AND conrelid = 'public.documents'::regclass) THEN
        ALTER TABLE ONLY public.documents ADD CONSTRAINT documents_movie_id_fkey FOREIGN KEY (movie_id) REFERENCES public.movies(id) ON DELETE CASCADE;
    END IF;
END $guard$;

--
-- Name: scenes scenes_movie_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $guard$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'scenes_movie_id_fkey'
                     AND conrelid = 'public.scenes'::regclass) THEN
        ALTER TABLE ONLY public.scenes ADD CONSTRAINT scenes_movie_id_fkey FOREIGN KEY (movie_id) REFERENCES public.movies(id) ON DELETE CASCADE;
    END IF;
END $guard$;

--
-- Name: screenplay_chunks screenplay_chunks_movie_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $guard$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'screenplay_chunks_movie_id_fkey'
                     AND conrelid = 'public.screenplay_chunks'::regclass) THEN
        ALTER TABLE ONLY public.screenplay_chunks ADD CONSTRAINT screenplay_chunks_movie_id_fkey FOREIGN KEY (movie_id) REFERENCES public.movies(id) ON DELETE CASCADE;
    END IF;
END $guard$;

--
-- Name: beats admin app full access; Type: POLICY; Schema: public; Owner: -
--

DO $guard$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public'
                     AND tablename = 'beats' AND policyname = 'admin app full access') THEN
        CREATE POLICY "admin app full access" ON public.beats TO anon, authenticated USING (true) WITH CHECK (true);
    END IF;
END $guard$;

--
-- Name: documents admin app full access; Type: POLICY; Schema: public; Owner: -
--

DO $guard$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public'
                     AND tablename = 'documents' AND policyname = 'admin app full access') THEN
        CREATE POLICY "admin app full access" ON public.documents TO anon, authenticated USING (true) WITH CHECK (true);
    END IF;
END $guard$;

--
-- Name: screenplay_chunks admin app full access; Type: POLICY; Schema: public; Owner: -
--

DO $guard$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public'
                     AND tablename = 'screenplay_chunks' AND policyname = 'admin app full access') THEN
        CREATE POLICY "admin app full access" ON public.screenplay_chunks TO anon, authenticated USING (true) WITH CHECK (true);
    END IF;
END $guard$;

--
-- Name: beats; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.beats ENABLE ROW LEVEL SECURITY;

--
-- Name: documents; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.documents ENABLE ROW LEVEL SECURITY;

--
-- Name: screenplay_chunks; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.screenplay_chunks ENABLE ROW LEVEL SECURITY;

--
-- Saving an edited structure. Called by the Screenplay tab, which is why it
-- lives with screenplay rather than with the tables it happens to mention.
--
--
-- Name: screenplay_apply_structure(uuid, jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE OR REPLACE FUNCTION public.screenplay_apply_structure(p_movie_id uuid, p_beats jsonb) RETURNS jsonb
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
  -- shots belongs to the director module, which may not be installed.
  -- With no shots table there are no shots to protect, so the check is
  -- skipped rather than failing.
  IF to_regclass('public.shots') IS NOT NULL THEN
    SELECT string_agg(DISTINCT coalesce(b.beat_code, 'seq ' || b.sequence_index), ', ')
    INTO v_blocked
    FROM public.beats b
    JOIN public.shots s ON s.beat_id = b.id
   WHERE b.movie_id = p_movie_id AND NOT (b.id = ANY(v_kept));
  END IF;
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
