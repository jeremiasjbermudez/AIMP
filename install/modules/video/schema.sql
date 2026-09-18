-- Video generation
-- Tables: minimax_clips
--
-- Replayed by install/install-module.ps1. Safe to run twice: every
-- statement is guarded, and the installer stops on the first real error.

--
-- Name: minimax_clips; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.minimax_clips (
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
-- Name: minimax_clips minimax_clips_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $guard$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'minimax_clips_pkey'
                     AND conrelid = 'public.minimax_clips'::regclass) THEN
        ALTER TABLE ONLY public.minimax_clips ADD CONSTRAINT minimax_clips_pkey PRIMARY KEY (id);
    END IF;
END $guard$;

--
-- Name: minimax_clips minimax_clips_update_timestamp; Type: TRIGGER; Schema: public; Owner: -
--

DROP TRIGGER IF EXISTS minimax_clips_update_timestamp ON public.minimax_clips;
CREATE TRIGGER minimax_clips_update_timestamp BEFORE UPDATE ON public.minimax_clips FOR EACH ROW EXECUTE FUNCTION system.update_updated_at();

--
-- Name: minimax_clips minimax_clips_source_clip_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $guard$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'minimax_clips_source_clip_id_fkey'
                     AND conrelid = 'public.minimax_clips'::regclass) THEN
        ALTER TABLE ONLY public.minimax_clips ADD CONSTRAINT minimax_clips_source_clip_id_fkey FOREIGN KEY (source_clip_id) REFERENCES public.minimax_clips(id) ON DELETE SET NULL;
    END IF;
END $guard$;

--
-- Name: minimax_clips minimax_clips_source_shot_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $guard$
BEGIN
        -- shots belongs to the director module, which may not be installed.
    -- The link is added when it is; installing director later re-applies
    -- this file, which picks it up then.
IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'minimax_clips_source_shot_id_fkey'
                     AND conrelid = 'public.minimax_clips'::regclass)
       AND to_regclass('public.shots') IS NOT NULL THEN
        ALTER TABLE ONLY public.minimax_clips ADD CONSTRAINT minimax_clips_source_shot_id_fkey FOREIGN KEY (source_shot_id) REFERENCES public.shots(id) ON DELETE SET NULL;
    END IF;
END $guard$;

--
-- Name: minimax_clips admin app full access; Type: POLICY; Schema: public; Owner: -
--

DO $guard$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public'
                     AND tablename = 'minimax_clips' AND policyname = 'admin app full access') THEN
        CREATE POLICY "admin app full access" ON public.minimax_clips TO anon, authenticated USING (true) WITH CHECK (true);
    END IF;
END $guard$;

--
-- Name: minimax_clips; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.minimax_clips ENABLE ROW LEVEL SECURITY;
