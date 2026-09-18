-- Score & voice
-- Tables: scores, score_styles, voice_replacements
--
-- Replayed by install/install-module.ps1. Safe to run twice: every
-- statement is guarded, and the installer stops on the first real error.

--
-- Name: score_styles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.score_styles (
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

CREATE TABLE IF NOT EXISTS public.scores (
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
-- Name: voice_replacements; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.voice_replacements (
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
-- Name: score_styles score_styles_axis_label_key; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $guard$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'score_styles_axis_label_key'
                     AND conrelid = 'public.score_styles'::regclass) THEN
        ALTER TABLE ONLY public.score_styles ADD CONSTRAINT score_styles_axis_label_key UNIQUE (axis, label);
    END IF;
END $guard$;

--
-- Name: score_styles score_styles_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $guard$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'score_styles_pkey'
                     AND conrelid = 'public.score_styles'::regclass) THEN
        ALTER TABLE ONLY public.score_styles ADD CONSTRAINT score_styles_pkey PRIMARY KEY (id);
    END IF;
END $guard$;

--
-- Name: scores scores_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $guard$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'scores_pkey'
                     AND conrelid = 'public.scores'::regclass) THEN
        ALTER TABLE ONLY public.scores ADD CONSTRAINT scores_pkey PRIMARY KEY (id);
    END IF;
END $guard$;

--
-- Name: voice_replacements voice_replacements_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $guard$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'voice_replacements_pkey'
                     AND conrelid = 'public.voice_replacements'::regclass) THEN
        ALTER TABLE ONLY public.voice_replacements ADD CONSTRAINT voice_replacements_pkey PRIMARY KEY (id);
    END IF;
END $guard$;

--
-- Name: idx_score_styles_axis; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS idx_score_styles_axis ON public.score_styles USING btree (axis, sort_order);

--
-- Name: scores scores_movie_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $guard$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'scores_movie_id_fkey'
                     AND conrelid = 'public.scores'::regclass) THEN
        ALTER TABLE ONLY public.scores ADD CONSTRAINT scores_movie_id_fkey FOREIGN KEY (movie_id) REFERENCES public.movies(id) ON DELETE CASCADE;
    END IF;
END $guard$;

--
-- Name: scores scores_source_clip_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $guard$
BEGIN
        -- minimax_clips belongs to the video module, which may not be installed.
    -- The link is added when it is; installing video later re-applies
    -- this file, which picks it up then.
IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'scores_source_clip_id_fkey'
                     AND conrelid = 'public.scores'::regclass)
       AND to_regclass('public.minimax_clips') IS NOT NULL THEN
        ALTER TABLE ONLY public.scores ADD CONSTRAINT scores_source_clip_id_fkey FOREIGN KEY (source_clip_id) REFERENCES public.minimax_clips(id) ON DELETE SET NULL;
    END IF;
END $guard$;

--
-- Name: voice_replacements voice_replacements_clip_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $guard$
BEGIN
        -- minimax_clips belongs to the video module, which may not be installed.
    -- The link is added when it is; installing video later re-applies
    -- this file, which picks it up then.
IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'voice_replacements_clip_id_fkey'
                     AND conrelid = 'public.voice_replacements'::regclass)
       AND to_regclass('public.minimax_clips') IS NOT NULL THEN
        ALTER TABLE ONLY public.voice_replacements ADD CONSTRAINT voice_replacements_clip_id_fkey FOREIGN KEY (clip_id) REFERENCES public.minimax_clips(id) ON DELETE CASCADE;
    END IF;
END $guard$;

--
-- Name: voice_replacements voice_replacements_movie_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $guard$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'voice_replacements_movie_id_fkey'
                     AND conrelid = 'public.voice_replacements'::regclass) THEN
        ALTER TABLE ONLY public.voice_replacements ADD CONSTRAINT voice_replacements_movie_id_fkey FOREIGN KEY (movie_id) REFERENCES public.movies(id) ON DELETE CASCADE;
    END IF;
END $guard$;

--
-- Name: score_styles admin app full access; Type: POLICY; Schema: public; Owner: -
--

DO $guard$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public'
                     AND tablename = 'score_styles' AND policyname = 'admin app full access') THEN
        CREATE POLICY "admin app full access" ON public.score_styles TO anon, authenticated USING (true) WITH CHECK (true);
    END IF;
END $guard$;

--
-- Name: scores admin app full access; Type: POLICY; Schema: public; Owner: -
--

DO $guard$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public'
                     AND tablename = 'scores' AND policyname = 'admin app full access') THEN
        CREATE POLICY "admin app full access" ON public.scores TO anon, authenticated USING (true) WITH CHECK (true);
    END IF;
END $guard$;

--
-- Name: voice_replacements admin app full access; Type: POLICY; Schema: public; Owner: -
--

DO $guard$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public'
                     AND tablename = 'voice_replacements' AND policyname = 'admin app full access') THEN
        CREATE POLICY "admin app full access" ON public.voice_replacements TO anon, authenticated USING (true) WITH CHECK (true);
    END IF;
END $guard$;

--
-- Name: score_styles; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.score_styles ENABLE ROW LEVEL SECURITY;

--
-- Name: scores; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.scores ENABLE ROW LEVEL SECURITY;

--
-- Name: voice_replacements; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.voice_replacements ENABLE ROW LEVEL SECURITY;
