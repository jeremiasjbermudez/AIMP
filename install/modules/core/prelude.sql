-- Extensions, schemas and functions every module needs.

-- Dumped from database version 15.18 (Debian 15.18-1.pgdg13+1)
-- Dumped by pg_dump version 18.4 (Debian 18.4-1.pgdg13+1)

SET statement_timeout = 0;

--
-- Name: public; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA IF NOT EXISTS public;

--
-- Name: SCHEMA public; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON SCHEMA public IS 'standard public schema';

--
-- PostgreSQL database dump complete
--

--
-- The timestamp trigger every table's updated_at uses.
--
-- InsForge creates system.update_updated_at() itself, so on an InsForge
-- database this does nothing. It is here because the module schemas call it by
-- name: without it they only apply to an InsForge database, and against a plain
-- Postgres they fail with "schema system does not exist" - which says nothing
-- about what is actually missing. Created only when absent, so InsForge's own
-- definition is never shadowed.
--
CREATE SCHEMA IF NOT EXISTS system;

DO $prelude$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'system' AND p.proname = 'update_updated_at'
    ) THEN
        CREATE FUNCTION system.update_updated_at() RETURNS trigger
            LANGUAGE plpgsql AS $fn$
        BEGIN
            NEW.updated_at = now();
            RETURN NEW;
        END;
        $fn$;
    END IF;
END $prelude$;
