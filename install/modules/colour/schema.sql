-- Colour & lighting
-- Tables: color_palettes, lighting_presets, lighting_preset_previews
--
-- Replayed by install/install-module.ps1. Safe to run twice: every
-- statement is guarded, and the installer stops on the first real error.

--
-- Name: color_palettes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.color_palettes (
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
-- Name: lighting_preset_previews; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.lighting_preset_previews (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    preset_id uuid NOT NULL,
    movie_id uuid NOT NULL,
    image_path text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

--
-- Name: lighting_presets; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.lighting_presets (
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
-- Name: color_palettes color_palettes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $guard$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'color_palettes_pkey'
                     AND conrelid = 'public.color_palettes'::regclass) THEN
        ALTER TABLE ONLY public.color_palettes ADD CONSTRAINT color_palettes_pkey PRIMARY KEY (id);
    END IF;
END $guard$;

--
-- Name: lighting_preset_previews lighting_preset_previews_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $guard$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'lighting_preset_previews_pkey'
                     AND conrelid = 'public.lighting_preset_previews'::regclass) THEN
        ALTER TABLE ONLY public.lighting_preset_previews ADD CONSTRAINT lighting_preset_previews_pkey PRIMARY KEY (id);
    END IF;
END $guard$;

--
-- Name: lighting_preset_previews lighting_preset_previews_preset_id_movie_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $guard$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'lighting_preset_previews_preset_id_movie_id_key'
                     AND conrelid = 'public.lighting_preset_previews'::regclass) THEN
        ALTER TABLE ONLY public.lighting_preset_previews ADD CONSTRAINT lighting_preset_previews_preset_id_movie_id_key UNIQUE (preset_id, movie_id);
    END IF;
END $guard$;

--
-- Name: lighting_presets lighting_presets_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $guard$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'lighting_presets_pkey'
                     AND conrelid = 'public.lighting_presets'::regclass) THEN
        ALTER TABLE ONLY public.lighting_presets ADD CONSTRAINT lighting_presets_pkey PRIMARY KEY (id);
    END IF;
END $guard$;

--
-- Name: idx_color_palettes_movie; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS idx_color_palettes_movie ON public.color_palettes USING btree (movie_id, created_at DESC);

--
-- Name: idx_lighting_preset_previews_movie; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS idx_lighting_preset_previews_movie ON public.lighting_preset_previews USING btree (movie_id);

--
-- Name: idx_lighting_presets_movie; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS idx_lighting_presets_movie ON public.lighting_presets USING btree (movie_id, created_at DESC);

--
-- Name: color_palettes color_palettes_movie_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $guard$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'color_palettes_movie_id_fkey'
                     AND conrelid = 'public.color_palettes'::regclass) THEN
        ALTER TABLE ONLY public.color_palettes ADD CONSTRAINT color_palettes_movie_id_fkey FOREIGN KEY (movie_id) REFERENCES public.movies(id) ON DELETE CASCADE;
    END IF;
END $guard$;

--
-- Name: lighting_preset_previews lighting_preset_previews_movie_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $guard$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'lighting_preset_previews_movie_id_fkey'
                     AND conrelid = 'public.lighting_preset_previews'::regclass) THEN
        ALTER TABLE ONLY public.lighting_preset_previews ADD CONSTRAINT lighting_preset_previews_movie_id_fkey FOREIGN KEY (movie_id) REFERENCES public.movies(id) ON DELETE CASCADE;
    END IF;
END $guard$;

--
-- Name: lighting_preset_previews lighting_preset_previews_preset_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $guard$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'lighting_preset_previews_preset_id_fkey'
                     AND conrelid = 'public.lighting_preset_previews'::regclass) THEN
        ALTER TABLE ONLY public.lighting_preset_previews ADD CONSTRAINT lighting_preset_previews_preset_id_fkey FOREIGN KEY (preset_id) REFERENCES public.lighting_presets(id) ON DELETE CASCADE;
    END IF;
END $guard$;

--
-- Name: lighting_presets lighting_presets_movie_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $guard$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'lighting_presets_movie_id_fkey'
                     AND conrelid = 'public.lighting_presets'::regclass) THEN
        ALTER TABLE ONLY public.lighting_presets ADD CONSTRAINT lighting_presets_movie_id_fkey FOREIGN KEY (movie_id) REFERENCES public.movies(id) ON DELETE CASCADE;
    END IF;
END $guard$;

--
-- Name: color_palettes admin app full access; Type: POLICY; Schema: public; Owner: -
--

DO $guard$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public'
                     AND tablename = 'color_palettes' AND policyname = 'admin app full access') THEN
        CREATE POLICY "admin app full access" ON public.color_palettes TO anon, authenticated USING (true) WITH CHECK (true);
    END IF;
END $guard$;

--
-- Name: lighting_preset_previews admin app full access; Type: POLICY; Schema: public; Owner: -
--

DO $guard$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public'
                     AND tablename = 'lighting_preset_previews' AND policyname = 'admin app full access') THEN
        CREATE POLICY "admin app full access" ON public.lighting_preset_previews TO anon, authenticated USING (true) WITH CHECK (true);
    END IF;
END $guard$;

--
-- Name: lighting_presets admin app full access; Type: POLICY; Schema: public; Owner: -
--

DO $guard$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public'
                     AND tablename = 'lighting_presets' AND policyname = 'admin app full access') THEN
        CREATE POLICY "admin app full access" ON public.lighting_presets TO anon, authenticated USING (true) WITH CHECK (true);
    END IF;
END $guard$;

--
-- Name: color_palettes; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.color_palettes ENABLE ROW LEVEL SECURITY;

--
-- Name: lighting_preset_previews; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.lighting_preset_previews ENABLE ROW LEVEL SECURITY;

--
-- Name: lighting_presets; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.lighting_presets ENABLE ROW LEVEL SECURITY;
