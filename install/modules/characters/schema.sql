-- Characters & props
-- Tables: characters, character_images, movie_props
--
-- Replayed by install/install-module.ps1. Safe to run twice: every
-- statement is guarded, and the installer stops on the first real error.

--
-- Name: character_images; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.character_images (
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

CREATE TABLE IF NOT EXISTS public.characters (
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
-- Name: movie_props; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.movie_props (
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
-- Name: character_images character_images_character_kind_version_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $guard$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'character_images_character_kind_version_unique'
                     AND conrelid = 'public.character_images'::regclass) THEN
        ALTER TABLE ONLY public.character_images ADD CONSTRAINT character_images_character_kind_version_unique UNIQUE (character_id, kind, version);
    END IF;
END $guard$;

--
-- Name: character_images character_images_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $guard$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'character_images_pkey'
                     AND conrelid = 'public.character_images'::regclass) THEN
        ALTER TABLE ONLY public.character_images ADD CONSTRAINT character_images_pkey PRIMARY KEY (id);
    END IF;
END $guard$;

--
-- Name: characters characters_movie_name_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $guard$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'characters_movie_name_unique'
                     AND conrelid = 'public.characters'::regclass) THEN
        ALTER TABLE ONLY public.characters ADD CONSTRAINT characters_movie_name_unique UNIQUE (movie_id, name);
    END IF;
END $guard$;

--
-- Name: characters characters_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $guard$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'characters_pkey'
                     AND conrelid = 'public.characters'::regclass) THEN
        ALTER TABLE ONLY public.characters ADD CONSTRAINT characters_pkey PRIMARY KEY (id);
    END IF;
END $guard$;

--
-- Name: movie_props movie_props_movie_id_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $guard$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'movie_props_movie_id_name_key'
                     AND conrelid = 'public.movie_props'::regclass) THEN
        ALTER TABLE ONLY public.movie_props ADD CONSTRAINT movie_props_movie_id_name_key UNIQUE (movie_id, name);
    END IF;
END $guard$;

--
-- Name: movie_props movie_props_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $guard$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'movie_props_pkey'
                     AND conrelid = 'public.movie_props'::regclass) THEN
        ALTER TABLE ONLY public.movie_props ADD CONSTRAINT movie_props_pkey PRIMARY KEY (id);
    END IF;
END $guard$;

--
-- Name: idx_character_images_char_version; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS idx_character_images_char_version ON public.character_images USING btree (character_id, version);

--
-- Name: idx_character_images_character_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS idx_character_images_character_id ON public.character_images USING btree (character_id);

--
-- Name: idx_character_images_wardrobe; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS idx_character_images_wardrobe ON public.character_images USING btree (character_id, wardrobe_prop_id) WHERE (wardrobe_prop_id IS NOT NULL);

--
-- Name: idx_characters_movie_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS idx_characters_movie_id ON public.characters USING btree (movie_id);

--
-- Name: idx_movie_props_movie; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS idx_movie_props_movie ON public.movie_props USING btree (movie_id, kind, name);

--
-- Name: character_images character_images_character_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $guard$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'character_images_character_id_fkey'
                     AND conrelid = 'public.character_images'::regclass) THEN
        ALTER TABLE ONLY public.character_images ADD CONSTRAINT character_images_character_id_fkey FOREIGN KEY (character_id) REFERENCES public.characters(id) ON DELETE CASCADE;
    END IF;
END $guard$;

--
-- Name: character_images character_images_wardrobe_prop_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $guard$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'character_images_wardrobe_prop_id_fkey'
                     AND conrelid = 'public.character_images'::regclass) THEN
        ALTER TABLE ONLY public.character_images ADD CONSTRAINT character_images_wardrobe_prop_id_fkey FOREIGN KEY (wardrobe_prop_id) REFERENCES public.movie_props(id) ON DELETE CASCADE;
    END IF;
END $guard$;

--
-- Name: characters characters_movie_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $guard$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'characters_movie_id_fkey'
                     AND conrelid = 'public.characters'::regclass) THEN
        ALTER TABLE ONLY public.characters ADD CONSTRAINT characters_movie_id_fkey FOREIGN KEY (movie_id) REFERENCES public.movies(id) ON DELETE CASCADE;
    END IF;
END $guard$;

--
-- Name: movie_props movie_props_movie_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $guard$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'movie_props_movie_id_fkey'
                     AND conrelid = 'public.movie_props'::regclass) THEN
        ALTER TABLE ONLY public.movie_props ADD CONSTRAINT movie_props_movie_id_fkey FOREIGN KEY (movie_id) REFERENCES public.movies(id) ON DELETE CASCADE;
    END IF;
END $guard$;

--
-- Name: character_images admin app full access; Type: POLICY; Schema: public; Owner: -
--

DO $guard$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public'
                     AND tablename = 'character_images' AND policyname = 'admin app full access') THEN
        CREATE POLICY "admin app full access" ON public.character_images TO anon, authenticated USING (true) WITH CHECK (true);
    END IF;
END $guard$;

--
-- Name: characters admin app full access; Type: POLICY; Schema: public; Owner: -
--

DO $guard$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public'
                     AND tablename = 'characters' AND policyname = 'admin app full access') THEN
        CREATE POLICY "admin app full access" ON public.characters TO anon, authenticated USING (true) WITH CHECK (true);
    END IF;
END $guard$;

--
-- Name: movie_props admin app full access; Type: POLICY; Schema: public; Owner: -
--

DO $guard$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public'
                     AND tablename = 'movie_props' AND policyname = 'admin app full access') THEN
        CREATE POLICY "admin app full access" ON public.movie_props TO anon, authenticated USING (true) WITH CHECK (true);
    END IF;
END $guard$;

--
-- Name: character_images; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.character_images ENABLE ROW LEVEL SECURITY;

--
-- Name: characters; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.characters ENABLE ROW LEVEL SECURITY;

--
-- Name: movie_props; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.movie_props ENABLE ROW LEVEL SECURITY;
