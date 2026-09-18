-- Core
-- Tables: movies, prompt_log, movie_frames, movie_reference_images, installed_modules
--
-- Replayed by install/install-module.ps1. Safe to run twice: every
-- statement is guarded, and the installer stops on the first real error.

--
-- Name: movie_frames; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.movie_frames (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    movie_id uuid NOT NULL,
    source_clip_id uuid,
    source_label text,
    frame_number integer,
    image_path text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

--
-- Name: movie_reference_images; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.movie_reference_images (
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

CREATE TABLE IF NOT EXISTS public.movies (
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

CREATE TABLE IF NOT EXISTS public.prompt_log (
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
-- Name: movie_frames movie_frames_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $guard$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'movie_frames_pkey'
                     AND conrelid = 'public.movie_frames'::regclass) THEN
        ALTER TABLE ONLY public.movie_frames ADD CONSTRAINT movie_frames_pkey PRIMARY KEY (id);
    END IF;
END $guard$;

--
-- Name: movie_reference_images movie_reference_images_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $guard$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'movie_reference_images_pkey'
                     AND conrelid = 'public.movie_reference_images'::regclass) THEN
        ALTER TABLE ONLY public.movie_reference_images ADD CONSTRAINT movie_reference_images_pkey PRIMARY KEY (id);
    END IF;
END $guard$;

--
-- Name: movies movies_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $guard$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'movies_pkey'
                     AND conrelid = 'public.movies'::regclass) THEN
        ALTER TABLE ONLY public.movies ADD CONSTRAINT movies_pkey PRIMARY KEY (id);
    END IF;
END $guard$;

--
-- Name: movies movies_slug_key; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $guard$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'movies_slug_key'
                     AND conrelid = 'public.movies'::regclass) THEN
        ALTER TABLE ONLY public.movies ADD CONSTRAINT movies_slug_key UNIQUE (slug);
    END IF;
END $guard$;

--
-- Name: prompt_log prompt_log_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $guard$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'prompt_log_pkey'
                     AND conrelid = 'public.prompt_log'::regclass) THEN
        ALTER TABLE ONLY public.prompt_log ADD CONSTRAINT prompt_log_pkey PRIMARY KEY (id);
    END IF;
END $guard$;

--
-- Name: idx_movie_frames_movie; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS idx_movie_frames_movie ON public.movie_frames USING btree (movie_id, created_at DESC);

--
-- Name: idx_movie_reference_images_movie; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS idx_movie_reference_images_movie ON public.movie_reference_images USING btree (movie_id);

--
-- Name: idx_movies_single_active; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX IF NOT EXISTS idx_movies_single_active ON public.movies USING btree (is_active) WHERE is_active;

--
-- Name: idx_prompt_log_movie_time; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS idx_prompt_log_movie_time ON public.prompt_log USING btree (movie_id, created_at DESC);

--
-- Name: idx_prompt_log_subject; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS idx_prompt_log_subject ON public.prompt_log USING btree (subject_table, subject_id, created_at DESC);

--
-- Name: movie_frames movie_frames_movie_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $guard$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'movie_frames_movie_id_fkey'
                     AND conrelid = 'public.movie_frames'::regclass) THEN
        ALTER TABLE ONLY public.movie_frames ADD CONSTRAINT movie_frames_movie_id_fkey FOREIGN KEY (movie_id) REFERENCES public.movies(id) ON DELETE CASCADE;
    END IF;
END $guard$;

--
-- Name: movie_reference_images movie_reference_images_movie_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $guard$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'movie_reference_images_movie_id_fkey'
                     AND conrelid = 'public.movie_reference_images'::regclass) THEN
        ALTER TABLE ONLY public.movie_reference_images ADD CONSTRAINT movie_reference_images_movie_id_fkey FOREIGN KEY (movie_id) REFERENCES public.movies(id) ON DELETE CASCADE;
    END IF;
END $guard$;

--
-- Name: prompt_log prompt_log_movie_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $guard$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'prompt_log_movie_id_fkey'
                     AND conrelid = 'public.prompt_log'::regclass) THEN
        ALTER TABLE ONLY public.prompt_log ADD CONSTRAINT prompt_log_movie_id_fkey FOREIGN KEY (movie_id) REFERENCES public.movies(id) ON DELETE CASCADE;
    END IF;
END $guard$;

--
-- Name: movie_frames admin app full access; Type: POLICY; Schema: public; Owner: -
--

DO $guard$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public'
                     AND tablename = 'movie_frames' AND policyname = 'admin app full access') THEN
        CREATE POLICY "admin app full access" ON public.movie_frames TO anon, authenticated USING (true) WITH CHECK (true);
    END IF;
END $guard$;

--
-- Name: movie_reference_images admin app full access; Type: POLICY; Schema: public; Owner: -
--

DO $guard$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public'
                     AND tablename = 'movie_reference_images' AND policyname = 'admin app full access') THEN
        CREATE POLICY "admin app full access" ON public.movie_reference_images TO anon, authenticated USING (true) WITH CHECK (true);
    END IF;
END $guard$;

--
-- Name: prompt_log admin app full access; Type: POLICY; Schema: public; Owner: -
--

DO $guard$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public'
                     AND tablename = 'prompt_log' AND policyname = 'admin app full access') THEN
        CREATE POLICY "admin app full access" ON public.prompt_log TO anon, authenticated USING (true) WITH CHECK (true);
    END IF;
END $guard$;

--
-- Name: movie_frames; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.movie_frames ENABLE ROW LEVEL SECURITY;

--
-- Name: movie_reference_images; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.movie_reference_images ENABLE ROW LEVEL SECURITY;

--
-- Name: prompt_log; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.prompt_log ENABLE ROW LEVEL SECURITY;
