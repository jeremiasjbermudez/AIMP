-- Locations & 3D worlds
-- Tables: scene_panos, scene_splats, hyworlds, prompt_worlds
--
-- Replayed by install/install-module.ps1. Safe to run twice: every
-- statement is guarded, and the installer stops on the first real error.

--
-- Name: hyworlds; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.hyworlds (
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
-- Name: prompt_worlds; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.prompt_worlds (
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
-- Name: scene_panos; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.scene_panos (
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

CREATE TABLE IF NOT EXISTS public.scene_splats (
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
-- Name: hyworlds hyworlds_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $guard$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hyworlds_pkey'
                     AND conrelid = 'public.hyworlds'::regclass) THEN
        ALTER TABLE ONLY public.hyworlds ADD CONSTRAINT hyworlds_pkey PRIMARY KEY (id);
    END IF;
END $guard$;

--
-- Name: prompt_worlds prompt_worlds_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $guard$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'prompt_worlds_pkey'
                     AND conrelid = 'public.prompt_worlds'::regclass) THEN
        ALTER TABLE ONLY public.prompt_worlds ADD CONSTRAINT prompt_worlds_pkey PRIMARY KEY (id);
    END IF;
END $guard$;

--
-- Name: scene_panos scene_panos_movie_act_scene_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $guard$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'scene_panos_movie_act_scene_unique'
                     AND conrelid = 'public.scene_panos'::regclass) THEN
        ALTER TABLE ONLY public.scene_panos ADD CONSTRAINT scene_panos_movie_act_scene_unique UNIQUE (movie_id, act_number, scene_number);
    END IF;
END $guard$;

--
-- Name: scene_panos scene_panos_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $guard$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'scene_panos_pkey'
                     AND conrelid = 'public.scene_panos'::regclass) THEN
        ALTER TABLE ONLY public.scene_panos ADD CONSTRAINT scene_panos_pkey PRIMARY KEY (id);
    END IF;
END $guard$;

--
-- Name: scene_splats scene_splats_movie_act_scene_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $guard$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'scene_splats_movie_act_scene_unique'
                     AND conrelid = 'public.scene_splats'::regclass) THEN
        ALTER TABLE ONLY public.scene_splats ADD CONSTRAINT scene_splats_movie_act_scene_unique UNIQUE (movie_id, act_number, scene_number);
    END IF;
END $guard$;

--
-- Name: scene_splats scene_splats_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $guard$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'scene_splats_pkey'
                     AND conrelid = 'public.scene_splats'::regclass) THEN
        ALTER TABLE ONLY public.scene_splats ADD CONSTRAINT scene_splats_pkey PRIMARY KEY (id);
    END IF;
END $guard$;

--
-- Name: idx_hyworlds_movie; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS idx_hyworlds_movie ON public.hyworlds USING btree (movie_id, created_at DESC);

--
-- Name: idx_prompt_worlds_movie; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS idx_prompt_worlds_movie ON public.prompt_worlds USING btree (movie_id, created_at DESC);

--
-- Name: idx_scene_panos_movie_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS idx_scene_panos_movie_id ON public.scene_panos USING btree (movie_id);

--
-- Name: idx_scene_splats_movie_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS idx_scene_splats_movie_id ON public.scene_splats USING btree (movie_id);

--
-- Name: hyworlds hyworlds_movie_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $guard$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hyworlds_movie_id_fkey'
                     AND conrelid = 'public.hyworlds'::regclass) THEN
        ALTER TABLE ONLY public.hyworlds ADD CONSTRAINT hyworlds_movie_id_fkey FOREIGN KEY (movie_id) REFERENCES public.movies(id) ON DELETE CASCADE;
    END IF;
END $guard$;

--
-- Name: prompt_worlds prompt_worlds_movie_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $guard$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'prompt_worlds_movie_id_fkey'
                     AND conrelid = 'public.prompt_worlds'::regclass) THEN
        ALTER TABLE ONLY public.prompt_worlds ADD CONSTRAINT prompt_worlds_movie_id_fkey FOREIGN KEY (movie_id) REFERENCES public.movies(id) ON DELETE CASCADE;
    END IF;
END $guard$;

--
-- Name: scene_panos scene_panos_movie_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $guard$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'scene_panos_movie_id_fkey'
                     AND conrelid = 'public.scene_panos'::regclass) THEN
        ALTER TABLE ONLY public.scene_panos ADD CONSTRAINT scene_panos_movie_id_fkey FOREIGN KEY (movie_id) REFERENCES public.movies(id) ON DELETE CASCADE;
    END IF;
END $guard$;

--
-- Name: scene_splats scene_splats_movie_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $guard$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'scene_splats_movie_id_fkey'
                     AND conrelid = 'public.scene_splats'::regclass) THEN
        ALTER TABLE ONLY public.scene_splats ADD CONSTRAINT scene_splats_movie_id_fkey FOREIGN KEY (movie_id) REFERENCES public.movies(id) ON DELETE CASCADE;
    END IF;
END $guard$;

--
-- Name: hyworlds admin app full access; Type: POLICY; Schema: public; Owner: -
--

DO $guard$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public'
                     AND tablename = 'hyworlds' AND policyname = 'admin app full access') THEN
        CREATE POLICY "admin app full access" ON public.hyworlds TO anon, authenticated USING (true) WITH CHECK (true);
    END IF;
END $guard$;

--
-- Name: prompt_worlds admin app full access; Type: POLICY; Schema: public; Owner: -
--

DO $guard$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public'
                     AND tablename = 'prompt_worlds' AND policyname = 'admin app full access') THEN
        CREATE POLICY "admin app full access" ON public.prompt_worlds TO anon, authenticated USING (true) WITH CHECK (true);
    END IF;
END $guard$;

--
-- Name: scene_panos admin app full access; Type: POLICY; Schema: public; Owner: -
--

DO $guard$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public'
                     AND tablename = 'scene_panos' AND policyname = 'admin app full access') THEN
        CREATE POLICY "admin app full access" ON public.scene_panos TO anon, authenticated USING (true) WITH CHECK (true);
    END IF;
END $guard$;

--
-- Name: scene_splats admin app full access; Type: POLICY; Schema: public; Owner: -
--

DO $guard$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public'
                     AND tablename = 'scene_splats' AND policyname = 'admin app full access') THEN
        CREATE POLICY "admin app full access" ON public.scene_splats TO anon, authenticated USING (true) WITH CHECK (true);
    END IF;
END $guard$;

--
-- Name: hyworlds; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.hyworlds ENABLE ROW LEVEL SECURITY;

--
-- Name: prompt_worlds; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.prompt_worlds ENABLE ROW LEVEL SECURITY;

--
-- Name: scene_panos; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.scene_panos ENABLE ROW LEVEL SECURITY;

--
-- Name: scene_splats; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.scene_splats ENABLE ROW LEVEL SECURITY;
