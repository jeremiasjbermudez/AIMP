# Reference library (optional)

A searchable store of source text — a novel, a treatment, research — that location and character
descriptions can fall back on when the script itself is thin.

> **Note on the table.** The database this was exported from holds the search function but not
> its table, so `schema.sql` reconstructs `book_chunks` from the columns that function reads.
> The column list is faithful to what the function needs rather than to a known original, and
> the embedding width is set to 768 - change it to match your embedding model.


## What you get

No tabs. This module adds nothing to the interface; it is a store that other flows read from.

A screenplay is a working document, not a description of a world. It says where a scene happens
and rarely what the place looks like, and it names people without saying how they carry
themselves. When a flow has to write a panorama prompt or a character description from a line
and a half of slug line, the result is generic. The reference library is the answer to that: the
long-form source the script was drawn from is split into chunks, each chunk is
embedded once, and a flow that needs more than the script gives it can ask for the passages
closest in meaning to what it is describing.

- The store is scoped per project, so one film's source text is never searched on behalf of
  another.
- Retrieval is by meaning rather than keyword, using vector similarity over the stored
  embeddings.
- Results come back ranked by similarity, capped by a match count and floored by a similarity
  threshold, so a query with nothing relevant behind it returns nothing rather than the least
  bad passage available.
- It is a fallback, not a source of truth. The script remains authoritative; the library only
  fills gaps the script leaves.

**Which module uses it:** the **world** module lists it as an optional dependency. Location work
is where a thin script hurts most — a panorama needs a described place — so that is where the
extra source text pays off. Nothing breaks if the library is absent; world simply works from
what the script and scene rows contain.

## What it installs

**Tables**

- `book_chunks` — the source text split into chunks, each with its position in the sequence, the
  project it belongs to, and the vector embedding used to search it.

Alongside the table the module installs a similarity-search function that takes a query
embedding and a project, and returns the closest chunks with their similarity scores, filtered
by a threshold and limited to a match count.

**Flows**

None. This module registers no flows and writes no flow ids into the admin environment; it is
storage plus a search function, called by flows that other modules install.

**ComfyUI node packs**

None.

**Models**

An embedding model, served by the same text host that the rest of the pipeline's language work
runs against — not through the render host, and not a file in the model root. It is pulled over
the network like the other text models, and it is small compared with anything in the image or
video stacks. The one hard requirement is consistency: the model that embeds the stored chunks
must be the model that embeds the queries, or the similarity scores are meaningless.

## Before you install

- **core** — the database this module's table lives in, and the text host that serves the
  embedding model.

This module also needs the `vector` extension available in PostgreSQL; the installer enables it,
but the extension has to be present in the database image for that to succeed. Have the
embedding model pulled on the text host before loading any source text, and decide on it once —
re-embedding an entire book because the model changed is avoidable work.

Disk and VRAM are negligible. Embeddings are small, and the cost scales with how much source
text you load rather than with anything the module itself installs.

## Install

```powershell
.\install-module.ps1 -Module library
```

Restart the dev server afterwards. No tab appears — this module adds none. What changes is that
flows which know how to consult the library now find it there.

## How it fits

This sits to the side of the spine rather than on it. Nothing feeds it from within the pipeline:
the source text is loaded in from outside, once, and it does not change as the film is made. It
feeds description work — principally the world module's location prompts — by supplying prose
about a place or a person that the screenplay never had room for. Everything downstream of those
descriptions benefits indirectly, and nothing downstream knows the library exists.

## Removing it

```powershell
.\uninstall-module.ps1 -Module library
```

The table is kept by default, which matters more here than elsewhere: re-loading and re-embedding
a whole source text is slow, so removing the module and putting it back later should not cost
that. Pass `-DropTables` to remove `book_chunks` as well — it is dropped with `CASCADE`, so
anything depending on it goes with it, and the stored text is not recoverable. The world
module treats this one as optional, so nothing has to be uninstalled first.
