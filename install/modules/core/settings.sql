-- Settings the operator changes from the app, not at install time.
--
-- The language model was originally chosen once, in install/install.env, and
-- baked into every flow's variables when that flow was installed. That made
-- changing it a re-install of every module that calls a model, which is far too
-- much ceremony for "use the other model".
--
-- So the choice lives here instead. The flows read this row on each call and
-- fall back to their installed variables when it is absent, which keeps an
-- install that never touches the app working exactly as before.

CREATE TABLE IF NOT EXISTS public.app_settings (
    key         text PRIMARY KEY,
    value       jsonb       NOT NULL DEFAULT '{}'::jsonb,
    updated_at  timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.app_settings ENABLE ROW LEVEL SECURITY;

-- Signed in only, NOT anon. The language-model row can hold an API key for a
-- hosted provider, and the anonymous role is what an unauthenticated request
-- gets. The flows reach it with the service key, which bypasses this entirely.
DO $settings$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies
        WHERE schemaname = 'public' AND tablename = 'app_settings'
          AND policyname = 'admin app settings'
    ) THEN
        CREATE POLICY "admin app settings"
            ON public.app_settings FOR ALL TO authenticated USING (true) WITH CHECK (true);
    END IF;
END $settings$;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.app_settings TO authenticated;

DROP TRIGGER IF EXISTS app_settings_updated_at ON public.app_settings;
CREATE TRIGGER app_settings_updated_at BEFORE UPDATE ON public.app_settings
    FOR EACH ROW EXECUTE FUNCTION system.update_updated_at();

--
-- The shape of the 'llm' row:
--
--   {
--     "selected": "<profile id>",
--     "profiles": [
--       { "id": "...", "label": "Local qwen", "provider": "ollama",
--         "url": "http://localhost:11434", "model": "qwen3:8b", "apiKey": "" }
--     ]
--   }
--
-- No row at all means "use whatever was set at install time", which is why
-- nothing is seeded here.
