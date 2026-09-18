-- Reference library (optional)
-- Tables: book_chunks
--
-- NOTE ON PROVENANCE. The database this schema was taken from holds the search
-- FUNCTION below but not the table it reads: the function is orphaned there.
-- The table definition here is reconstructed from the columns the function
-- uses. It is faithful to what the function needs, and may be narrower than
-- whatever the original was.
--
-- Replayed by install/install-module.ps1. Safe to run twice.

CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS public.book_chunks (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    movie_id     uuid NOT NULL REFERENCES public.movies(id) ON DELETE CASCADE,
    -- Position in the source text, so a match can be read in context.
    chunk_index  integer NOT NULL,
    content      text NOT NULL,
    -- 768 dimensions, which is what the embedding model this was built against
    -- returns. Change it to match yours; the index and the function follow the
    -- column rather than fixing their own size.
    embedding    public.vector(768),
    created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_book_chunks_movie ON public.book_chunks (movie_id, chunk_index);

-- Approximate nearest neighbour over cosine distance, the operator the function
-- uses. Exact search is fine for a few thousand chunks; this keeps it fast past
-- that.
CREATE INDEX IF NOT EXISTS idx_book_chunks_embedding
    ON public.book_chunks USING ivfflat (embedding public.vector_cosine_ops) WITH (lists = 100);

ALTER TABLE public.book_chunks ENABLE ROW LEVEL SECURITY;

DO $policy$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies
        WHERE schemaname = 'public' AND tablename = 'book_chunks'
          AND policyname = 'admin app full access'
    ) THEN
        CREATE POLICY "admin app full access"
            ON public.book_chunks FOR ALL TO anon, authenticated USING (true) WITH CHECK (true);
    END IF;
END $policy$;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.book_chunks TO anon, authenticated;

--
-- The search itself: the nearest chunks within one project, above a similarity
-- floor. Taken verbatim from the live database.
--
CREATE OR REPLACE FUNCTION public.match_book_chunks(query_embedding public.vector, filter_movie_id uuid, match_count integer DEFAULT 5, match_threshold double precision DEFAULT 0.35) RETURNS TABLE(id uuid, content text, chunk_index integer, similarity double precision)
    LANGUAGE sql STABLE
    AS $$
  SELECT
    public.book_chunks.id,
    public.book_chunks.content,
    public.book_chunks.chunk_index,
    1 - (public.book_chunks.embedding <=> query_embedding) AS similarity
  FROM public.book_chunks
  WHERE public.book_chunks.movie_id = filter_movie_id
    AND 1 - (public.book_chunks.embedding <=> query_embedding) >= match_threshold
  ORDER BY public.book_chunks.embedding <=> query_embedding
  LIMIT match_count;
$$;
