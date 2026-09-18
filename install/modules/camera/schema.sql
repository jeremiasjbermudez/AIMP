-- Cameras & plates
-- Tables: scene_floor_plans, shot_cameras, camera_plates, camera_presets
--
-- Replayed by install/install-module.ps1. Safe to run twice: every
-- statement is guarded, and the installer stops on the first real error.

--
-- Name: camera_plates; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.camera_plates (
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

CREATE TABLE IF NOT EXISTS public.camera_presets (
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
-- Name: scene_floor_plans; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.scene_floor_plans (
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
-- Name: shot_cameras; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.shot_cameras (
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
-- Name: camera_plates camera_plates_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $guard$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'camera_plates_pkey'
                     AND conrelid = 'public.camera_plates'::regclass) THEN
        ALTER TABLE ONLY public.camera_plates ADD CONSTRAINT camera_plates_pkey PRIMARY KEY (id);
    END IF;
END $guard$;

--
-- Name: camera_presets camera_presets_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $guard$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'camera_presets_pkey'
                     AND conrelid = 'public.camera_presets'::regclass) THEN
        ALTER TABLE ONLY public.camera_presets ADD CONSTRAINT camera_presets_pkey PRIMARY KEY (id);
    END IF;
END $guard$;

--
-- Name: scene_floor_plans scene_floor_plans_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $guard$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'scene_floor_plans_pkey'
                     AND conrelid = 'public.scene_floor_plans'::regclass) THEN
        ALTER TABLE ONLY public.scene_floor_plans ADD CONSTRAINT scene_floor_plans_pkey PRIMARY KEY (id);
    END IF;
END $guard$;

--
-- Name: shot_cameras shot_cameras_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $guard$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'shot_cameras_pkey'
                     AND conrelid = 'public.shot_cameras'::regclass) THEN
        ALTER TABLE ONLY public.shot_cameras ADD CONSTRAINT shot_cameras_pkey PRIMARY KEY (id);
    END IF;
END $guard$;

--
-- Name: idx_camera_plates_camera; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS idx_camera_plates_camera ON public.camera_plates USING btree (shot_camera_id, created_at DESC);

--
-- Name: idx_camera_plates_plan; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS idx_camera_plates_plan ON public.camera_plates USING btree (floor_plan_id);

--
-- Name: idx_camera_presets_cat; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS idx_camera_presets_cat ON public.camera_presets USING btree (category, sort_order, name);

--
-- Name: idx_floor_plans_scene; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS idx_floor_plans_scene ON public.scene_floor_plans USING btree (movie_id, act_number, scene_number, created_at DESC);

--
-- Name: idx_shot_cameras_one_chosen; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX IF NOT EXISTS idx_shot_cameras_one_chosen ON public.shot_cameras USING btree (shot_id) WHERE is_chosen;

--
-- Name: idx_shot_cameras_shot; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS idx_shot_cameras_shot ON public.shot_cameras USING btree (shot_id, is_chosen DESC, created_at DESC);

--
-- Name: camera_plates camera_plates_floor_plan_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $guard$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'camera_plates_floor_plan_id_fkey'
                     AND conrelid = 'public.camera_plates'::regclass) THEN
        ALTER TABLE ONLY public.camera_plates ADD CONSTRAINT camera_plates_floor_plan_id_fkey FOREIGN KEY (floor_plan_id) REFERENCES public.scene_floor_plans(id) ON DELETE CASCADE;
    END IF;
END $guard$;

--
-- Name: camera_plates camera_plates_shot_camera_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $guard$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'camera_plates_shot_camera_id_fkey'
                     AND conrelid = 'public.camera_plates'::regclass) THEN
        ALTER TABLE ONLY public.camera_plates ADD CONSTRAINT camera_plates_shot_camera_id_fkey FOREIGN KEY (shot_camera_id) REFERENCES public.shot_cameras(id) ON DELETE CASCADE;
    END IF;
END $guard$;

--
-- Name: camera_presets camera_presets_movie_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $guard$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'camera_presets_movie_id_fkey'
                     AND conrelid = 'public.camera_presets'::regclass) THEN
        ALTER TABLE ONLY public.camera_presets ADD CONSTRAINT camera_presets_movie_id_fkey FOREIGN KEY (movie_id) REFERENCES public.movies(id) ON DELETE CASCADE;
    END IF;
END $guard$;

--
-- Name: scene_floor_plans scene_floor_plans_movie_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $guard$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'scene_floor_plans_movie_id_fkey'
                     AND conrelid = 'public.scene_floor_plans'::regclass) THEN
        ALTER TABLE ONLY public.scene_floor_plans ADD CONSTRAINT scene_floor_plans_movie_id_fkey FOREIGN KEY (movie_id) REFERENCES public.movies(id) ON DELETE CASCADE;
    END IF;
END $guard$;

--
-- Name: shot_cameras shot_cameras_shot_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $guard$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'shot_cameras_shot_id_fkey'
                     AND conrelid = 'public.shot_cameras'::regclass) THEN
        ALTER TABLE ONLY public.shot_cameras ADD CONSTRAINT shot_cameras_shot_id_fkey FOREIGN KEY (shot_id) REFERENCES public.director_shots(id) ON DELETE CASCADE;
    END IF;
END $guard$;

--
-- Name: camera_plates admin app full access; Type: POLICY; Schema: public; Owner: -
--

DO $guard$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public'
                     AND tablename = 'camera_plates' AND policyname = 'admin app full access') THEN
        CREATE POLICY "admin app full access" ON public.camera_plates TO anon, authenticated USING (true) WITH CHECK (true);
    END IF;
END $guard$;

--
-- Name: camera_presets admin app full access; Type: POLICY; Schema: public; Owner: -
--

DO $guard$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public'
                     AND tablename = 'camera_presets' AND policyname = 'admin app full access') THEN
        CREATE POLICY "admin app full access" ON public.camera_presets TO anon, authenticated USING (true) WITH CHECK (true);
    END IF;
END $guard$;

--
-- Name: scene_floor_plans admin app full access; Type: POLICY; Schema: public; Owner: -
--

DO $guard$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public'
                     AND tablename = 'scene_floor_plans' AND policyname = 'admin app full access') THEN
        CREATE POLICY "admin app full access" ON public.scene_floor_plans TO anon, authenticated USING (true) WITH CHECK (true);
    END IF;
END $guard$;

--
-- Name: shot_cameras admin app full access; Type: POLICY; Schema: public; Owner: -
--

DO $guard$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public'
                     AND tablename = 'shot_cameras' AND policyname = 'admin app full access') THEN
        CREATE POLICY "admin app full access" ON public.shot_cameras TO anon, authenticated USING (true) WITH CHECK (true);
    END IF;
END $guard$;

--
-- Name: camera_plates; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.camera_plates ENABLE ROW LEVEL SECURITY;

--
-- Name: camera_presets; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.camera_presets ENABLE ROW LEVEL SECURITY;

--
-- Name: scene_floor_plans; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.scene_floor_plans ENABLE ROW LEVEL SECURITY;

--
-- Name: shot_cameras; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.shot_cameras ENABLE ROW LEVEL SECURITY;
