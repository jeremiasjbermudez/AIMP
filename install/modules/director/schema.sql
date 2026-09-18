-- Director & shot lists
-- Tables: director_plans, director_shots, shots
--
-- Replayed by install/install-module.ps1. Safe to run twice: every
-- statement is guarded, and the installer stops on the first real error.


--
-- Name: director_plans; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.director_plans (
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

CREATE TABLE IF NOT EXISTS public.director_shots (
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
-- Name: shots; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.shots (
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
-- Name: director_plans director_plans_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $guard$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'director_plans_pkey'
                     AND conrelid = 'public.director_plans'::regclass) THEN
        ALTER TABLE ONLY public.director_plans ADD CONSTRAINT director_plans_pkey PRIMARY KEY (id);
    END IF;
END $guard$;

--
-- Name: director_shots director_shots_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $guard$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'director_shots_pkey'
                     AND conrelid = 'public.director_shots'::regclass) THEN
        ALTER TABLE ONLY public.director_shots ADD CONSTRAINT director_shots_pkey PRIMARY KEY (id);
    END IF;
END $guard$;

--
-- Name: director_shots director_shots_plan_id_position_key; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $guard$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'director_shots_plan_id_position_key'
                     AND conrelid = 'public.director_shots'::regclass) THEN
        ALTER TABLE ONLY public.director_shots ADD CONSTRAINT director_shots_plan_id_position_key UNIQUE (plan_id, "position");
    END IF;
END $guard$;

--
-- Name: shots shots_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $guard$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'shots_pkey'
                     AND conrelid = 'public.shots'::regclass) THEN
        ALTER TABLE ONLY public.shots ADD CONSTRAINT shots_pkey PRIMARY KEY (id);
    END IF;
END $guard$;

--
-- Name: idx_director_plans_movie; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS idx_director_plans_movie ON public.director_plans USING btree (movie_id, created_at DESC);

--
-- Name: idx_director_shots_plan; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS idx_director_shots_plan ON public.director_shots USING btree (plan_id, "position");

--
-- Name: idx_shots_beat_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS idx_shots_beat_id ON public.shots USING btree (beat_id);

--
-- Name: idx_shots_movie_scene; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS idx_shots_movie_scene ON public.shots USING btree (movie_id, act_number, scene_number);

--
-- Name: shots shots_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

DROP TRIGGER IF EXISTS shots_updated_at ON public.shots;
CREATE TRIGGER shots_updated_at BEFORE UPDATE ON public.shots FOR EACH ROW EXECUTE FUNCTION system.update_updated_at();

--
-- Name: director_plans director_plans_movie_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $guard$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'director_plans_movie_id_fkey'
                     AND conrelid = 'public.director_plans'::regclass) THEN
        ALTER TABLE ONLY public.director_plans ADD CONSTRAINT director_plans_movie_id_fkey FOREIGN KEY (movie_id) REFERENCES public.movies(id) ON DELETE CASCADE;
    END IF;
END $guard$;

--
-- Name: director_shots director_shots_beat_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $guard$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'director_shots_beat_id_fkey'
                     AND conrelid = 'public.director_shots'::regclass) THEN
        ALTER TABLE ONLY public.director_shots ADD CONSTRAINT director_shots_beat_id_fkey FOREIGN KEY (beat_id) REFERENCES public.beats(id) ON DELETE SET NULL;
    END IF;
END $guard$;

--
-- Name: director_shots director_shots_clip_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $guard$
BEGIN
        -- minimax_clips belongs to the video module, which may not be installed.
    -- The link is added when it is; installing video later re-applies
    -- this file, which picks it up then.
IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'director_shots_clip_id_fkey'
                     AND conrelid = 'public.director_shots'::regclass)
       AND to_regclass('public.minimax_clips') IS NOT NULL THEN
        ALTER TABLE ONLY public.director_shots ADD CONSTRAINT director_shots_clip_id_fkey FOREIGN KEY (clip_id) REFERENCES public.minimax_clips(id) ON DELETE SET NULL;
    END IF;
END $guard$;

--
-- Name: director_shots director_shots_movie_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $guard$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'director_shots_movie_id_fkey'
                     AND conrelid = 'public.director_shots'::regclass) THEN
        ALTER TABLE ONLY public.director_shots ADD CONSTRAINT director_shots_movie_id_fkey FOREIGN KEY (movie_id) REFERENCES public.movies(id) ON DELETE CASCADE;
    END IF;
END $guard$;

--
-- Name: director_shots director_shots_plan_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $guard$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'director_shots_plan_id_fkey'
                     AND conrelid = 'public.director_shots'::regclass) THEN
        ALTER TABLE ONLY public.director_shots ADD CONSTRAINT director_shots_plan_id_fkey FOREIGN KEY (plan_id) REFERENCES public.director_plans(id) ON DELETE CASCADE;
    END IF;
END $guard$;

--
-- Name: shots shots_beat_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $guard$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'shots_beat_id_fkey'
                     AND conrelid = 'public.shots'::regclass) THEN
        ALTER TABLE ONLY public.shots ADD CONSTRAINT shots_beat_id_fkey FOREIGN KEY (beat_id) REFERENCES public.beats(id);
    END IF;
END $guard$;

--
-- Name: shots shots_movie_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $guard$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'shots_movie_id_fkey'
                     AND conrelid = 'public.shots'::regclass) THEN
        ALTER TABLE ONLY public.shots ADD CONSTRAINT shots_movie_id_fkey FOREIGN KEY (movie_id) REFERENCES public.movies(id);
    END IF;
END $guard$;

--
-- Name: director_plans admin app full access; Type: POLICY; Schema: public; Owner: -
--

DO $guard$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public'
                     AND tablename = 'director_plans' AND policyname = 'admin app full access') THEN
        CREATE POLICY "admin app full access" ON public.director_plans TO anon, authenticated USING (true) WITH CHECK (true);
    END IF;
END $guard$;

--
-- Name: director_shots admin app full access; Type: POLICY; Schema: public; Owner: -
--

DO $guard$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public'
                     AND tablename = 'director_shots' AND policyname = 'admin app full access') THEN
        CREATE POLICY "admin app full access" ON public.director_shots TO anon, authenticated USING (true) WITH CHECK (true);
    END IF;
END $guard$;

--
-- Name: shots admin app full access; Type: POLICY; Schema: public; Owner: -
--

DO $guard$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public'
                     AND tablename = 'shots' AND policyname = 'admin app full access') THEN
        CREATE POLICY "admin app full access" ON public.shots TO anon, authenticated USING (true) WITH CHECK (true);
    END IF;
END $guard$;

--
-- Name: director_plans; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.director_plans ENABLE ROW LEVEL SECURITY;

--
-- Name: director_shots; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.director_shots ENABLE ROW LEVEL SECURITY;

--
-- Name: shots; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.shots ENABLE ROW LEVEL SECURITY;
