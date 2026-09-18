-- The installer's own record of what is installed.
--
-- Written by install-module.ps1, read by the admin app so it can show a tab
-- only when its module is present, and by the installer so it can refuse to
-- install something whose dependencies are missing.

CREATE TABLE IF NOT EXISTS public.installed_modules (
    name           text PRIMARY KEY,
    version        text        NOT NULL DEFAULT '1',
    installed_at   timestamptz NOT NULL DEFAULT now(),
    -- The flows this module registered, as {envVarName: flowId}. Uninstall
    -- reads it back so it can remove exactly what it created and nothing else.
    flow_ids       jsonb       NOT NULL DEFAULT '{}'::jsonb,
    -- The tabs it contributes, so the admin app does not need its own copy of
    -- the module map.
    tabs           text[]      NOT NULL DEFAULT '{}',
    notes          text
);

ALTER TABLE public.installed_modules ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies
        WHERE schemaname = 'public' AND tablename = 'installed_modules'
          AND policyname = 'installed modules readable'
    ) THEN
        -- The browser only ever reads this; the installer writes it with the
        -- service role.
        CREATE POLICY "installed modules readable"
            ON public.installed_modules FOR SELECT TO anon, authenticated USING (true);
    END IF;
END $$;

GRANT SELECT ON public.installed_modules TO anon, authenticated;
