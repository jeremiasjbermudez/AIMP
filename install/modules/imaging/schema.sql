-- Image generation & editing
-- Tables: image_edits, qwen_cleanups
--
-- Replayed by install/install-module.ps1. Safe to run twice: every
-- statement is guarded, and the installer stops on the first real error.

--
-- Name: image_edits; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.image_edits (
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
-- Name: qwen_cleanups; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.qwen_cleanups (
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
-- Name: image_edits image_edits_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $guard$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'image_edits_pkey'
                     AND conrelid = 'public.image_edits'::regclass) THEN
        ALTER TABLE ONLY public.image_edits ADD CONSTRAINT image_edits_pkey PRIMARY KEY (id);
    END IF;
END $guard$;

--
-- Name: qwen_cleanups qwen_cleanups_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $guard$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'qwen_cleanups_pkey'
                     AND conrelid = 'public.qwen_cleanups'::regclass) THEN
        ALTER TABLE ONLY public.qwen_cleanups ADD CONSTRAINT qwen_cleanups_pkey PRIMARY KEY (id);
    END IF;
END $guard$;

--
-- Name: idx_image_edits_movie; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS idx_image_edits_movie ON public.image_edits USING btree (movie_id, created_at DESC);

--
-- Name: image_edits image_edits_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

DROP TRIGGER IF EXISTS image_edits_updated_at ON public.image_edits;
CREATE TRIGGER image_edits_updated_at BEFORE UPDATE ON public.image_edits FOR EACH ROW EXECUTE FUNCTION system.update_updated_at();

--
-- Name: qwen_cleanups qwen_cleanups_update_timestamp; Type: TRIGGER; Schema: public; Owner: -
--

DROP TRIGGER IF EXISTS qwen_cleanups_update_timestamp ON public.qwen_cleanups;
CREATE TRIGGER qwen_cleanups_update_timestamp BEFORE UPDATE ON public.qwen_cleanups FOR EACH ROW EXECUTE FUNCTION system.update_updated_at();

--
-- Name: image_edits image_edits_movie_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $guard$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'image_edits_movie_id_fkey'
                     AND conrelid = 'public.image_edits'::regclass) THEN
        ALTER TABLE ONLY public.image_edits ADD CONSTRAINT image_edits_movie_id_fkey FOREIGN KEY (movie_id) REFERENCES public.movies(id) ON DELETE CASCADE;
    END IF;
END $guard$;

--
-- Name: image_edits admin app full access; Type: POLICY; Schema: public; Owner: -
--

DO $guard$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public'
                     AND tablename = 'image_edits' AND policyname = 'admin app full access') THEN
        CREATE POLICY "admin app full access" ON public.image_edits TO anon, authenticated USING (true) WITH CHECK (true);
    END IF;
END $guard$;

--
-- Name: qwen_cleanups admin app full access; Type: POLICY; Schema: public; Owner: -
--

DO $guard$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public'
                     AND tablename = 'qwen_cleanups' AND policyname = 'admin app full access') THEN
        CREATE POLICY "admin app full access" ON public.qwen_cleanups TO anon, authenticated USING (true) WITH CHECK (true);
    END IF;
END $guard$;

--
-- Name: image_edits; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.image_edits ENABLE ROW LEVEL SECURITY;

--
-- Name: qwen_cleanups; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.qwen_cleanups ENABLE ROW LEVEL SECURITY;
