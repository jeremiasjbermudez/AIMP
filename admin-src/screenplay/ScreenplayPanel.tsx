import { useEffect, useRef, useState } from 'react'
import { insforge, type Movie } from '../insforge'
import {
  addAct, addBeat, addScene, deleteAct, deleteBeat, deleteScene,
  moveAct, moveBeat, moveScene, newScreenplay, updateBeat, updateScene,
  countScenes, flatten, type ScreenplayTree
} from './model'
import {
  loadTree, saveTree, breakDown, enhanceBeat, proposeBible, commitBible,
  runSceneImport, startOrchestration, exportScreenplay, type BibleProposal
} from './api'
import { parseFlowJson, triggerFlow, type RunStatus } from '../flowise'
import { WriterChat } from '../ui/WriterChat'
import { pdfToText } from './pdf'
import { splitBook, bookToScreenplay, type Chunk, type BookProgress } from './book'

type DocRow = { id: string; original_filename: string; storage_key: string; kind: string }

// Where a screenplay is written. Acts contain scenes contain beats; every
// number is derived from position, so inserting a beat mid-scene pushes the
// rest along automatically.

export function ScreenplayPanel({ movie }: { movie: Movie }) {
  const [tree, setTree] = useState<ScreenplayTree | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [dirty, setDirty] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [openBeat, setOpenBeat] = useState<string>('0-0-0')
  const [prose, setProse] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [bible, setBible] = useState<BibleProposal | null>(null)
  const [run, setRun] = useState<RunStatus | null>(null)
  const [exported, setExported] = useState<string | null>(null)
  // The screenplay documents already uploaded to this movie. They were only
  // ever viewable from the Documents tab - there was no way to get one INTO the
  // builder, which is where it has to be to become acts, scenes and beats.
  const [docs, setDocs] = useState<DocRow[]>([])
  // Every document on the movie, whatever its kind: a book is usually filed as
  // something other than "screenplay", so the converter cannot be limited to
  // that one kind the way the screenplay import is.
  const [allDocs, setAllDocs] = useState<DocRow[]>([])
  const [book, setBook] = useState<{ chunks: Chunk[]; from: string } | null>(null)
  const [bookAt, setBookAt] = useState<BookProgress | null>(null)
  const stopBook = useRef(false)

  useEffect(() => {
    insforge.database
      .from('documents')
      .select('id,original_filename,storage_key,kind')
      .eq('movie_id', movie.id)
      .order('created_at', { ascending: false })
      .then(({ data }) => {
        const rows = (data ?? []) as DocRow[]
        setAllDocs(rows)
        setDocs(rows.filter((d) => d.kind === 'screenplay'))
      })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [movie.id])

  /** Read a stored document as text, extracting a PDF if that is what it is. */
  async function readDoc(doc: DocRow): Promise<string | null> {
    const { data: blob, error: e } = await insforge.storage
      .from(movie.bucket_name)
      .download(doc.storage_key)
    if (e || !blob) {
      setError(e?.message ?? 'Could not read that document.')
      return null
    }
    const isPdf = /\.pdf$/i.test(doc.original_filename) || blob.type === 'application/pdf'
    const text = isPdf ? await pdfToText(await blob.arrayBuffer()) : await blob.text()
    if (!text.trim()) {
      setError(
        isPdf
          ? `No text could be read from ${doc.original_filename} - if it is a scan rather than a real PDF, it has no text in it to extract.`
          : `${doc.original_filename} is empty.`
      )
      return null
    }
    return text
  }

  /** Cut a book into chapters so you can see the shape before spending an hour. */
  async function planBook(doc: DocRow) {
    setError(null)
    setBusy('book-read')
    try {
      const text = await readDoc(doc)
      if (!text) return
      const chunks = splitBook(text)
      if (!chunks.length) {
        setError(`Nothing readable in ${doc.original_filename}.`)
        return
      }
      setBook({ chunks, from: doc.original_filename })
      setBookAt(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(null)
    }
  }

  /**
   * Convert the book, then save and export in the same pass, because a
   * converted book that is only in the browser is one refresh from gone.
   */
  async function convertBook() {
    if (!book) return
    stopBook.current = false
    setError(null)
    setBusy('book')
    try {
      const { tree: built, converted, failures } = await bookToScreenplay(
        book.chunks,
        setBookAt,
        () => stopBook.current
      )
      if (!flatten(built).length) {
        setError(failures[0] ?? 'Nothing was converted.')
        return
      }
      setTree(built)
      const saved = await saveTree(movie.id, built)
      if ('error' in saved) {
        setError(saved.error)
        setDirty(true)
        return
      }
      setTree(saved.tree)
      setDirty(false)
      const out = await exportScreenplay(movie, saved.tree)
      if ('error' in out) {
        setError(out.error)
        return
      }
      setExported(out.text)
      setBook(null)
      setNote(
        `${converted} of ${book.chunks.length} chapters converted into ${countScenes(saved.tree)} scenes` +
          ` and saved as the screenplay document.` +
          (failures.length ? ` ${failures.length} chapter(s) failed: ${failures[0]}` : '')
      )
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(null)
      setBookAt(null)
    }
  }

  /** Pull a stored screenplay into the box so it can be broken down. */
  async function loadFromDocuments(doc: DocRow) {
    setError(null)
    setBusy('import')
    try {
      const text = await readDoc(doc)
      if (text) setProse(text)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(null)
    }
  }

  useEffect(() => {
    async function load() {
      setLoading(true)
      setError(null)
      setNote(null)
      setDirty(false)
      const result = await loadTree(movie.id)
      if ('error' in result) setError(result.error)
      else setTree(result.tree)
      setLoading(false)
    }
    load()
  }, [movie.id])

  function change(next: ScreenplayTree) {
    setTree(next)
    setDirty(true)
    setNote(null)
  }

  async function handleSave() {
    if (!tree) return
    setSaving(true)
    setError(null)
    const result = await saveTree(movie.id, tree)
    setSaving(false)
    if ('error' in result) {
      setError(result.error)
      return
    }
    setTree(result.tree)
    setDirty(false)
    setNote(`Saved ${flatten(result.tree).length} beats.`)
  }

  async function handleBreakDown() {
    if (!prose.trim()) return
    setBusy('breakdown')
    setError(null)
    const res = await breakDown(prose)
    setBusy(null)
    if ('error' in res) {
      setError(res.error)
      return
    }
    // Replace rather than merge: this is the first draft of a story, and
    // silently appending to whatever was already there would be worse than
    // asking. Existing work is only overwritten once Save is pressed.
    change(res.tree)
    setNote('Broken down. Review it, then Save.')
  }

  async function handleEnhance(ai: number, si: number, bi: number) {
    if (!tree) return
    const scene = tree.acts[ai].scenes[si]
    const beat = scene.beats[bi]
    setBusy(`enhance-${ai}-${si}-${bi}`)
    setError(null)
    const res = await enhanceBeat(beat, scene.scene_heading ?? '', '')
    setBusy(null)
    if ('error' in res) {
      setError(res.error)
      return
    }
    change(updateBeat(tree, ai, si, bi, res.fields))
    setNote(res.dialogueKept ? 'Beat enhanced.' : 'Beat enhanced — dialogue was kept as written.')
  }

  // A shot breakdown, in.
  //
  // The Tools tab turns a film into beats AND a shot per cut. Both belong here:
  // this is where a screenplay is written, and a breakdown is a screenplay that
  // was read off a film instead of typed. It writes the beats and a director
  // plan carrying the real coverage - sizes, foregrounds, how long each shot
  // holds - so the Director starts from that instead of inventing its own.
  //
  // The tree is reloaded afterwards rather than merged into: the import replaces
  // the act outright, and showing edits made against beats that no longer exist
  // would be showing you a script nobody has.
  async function importBreakdown() {
    const pick = import.meta.env.VITE_SHOT_BREAKDOWN_ID
    const imp = import.meta.env.VITE_IMPORT_BREAKDOWN_ID
    if (!pick || !imp) {
      setError('VITE_SHOT_BREAKDOWN_ID and VITE_IMPORT_BREAKDOWN_ID must be set in .env.')
      return
    }
    setBusy('breakdown')
    setError(null)
    try {
      const chosen = parseFlowJson<{ action: string; videoPath?: string }>(
        await triggerFlow(pick, { mode: 'choose', want: 'shots' })
      )
      if (!chosen.ok) {
        setError(chosen.message)
        return
      }
      if (chosen.data.action !== 'chose' || !chosen.data.videoPath) return
      // The picker points at shots.json; the import reads screenplay.json,
      // which the Tools tab writes beside it.
      const sp = chosen.data.videoPath.replace(/shots\.json$/i, 'screenplay.json')
      const res = parseFlowJson<{ action: string; note?: string; notes?: string[]; error?: string }>(
        await triggerFlow(imp, { movieId: movie.id, screenplayJson: sp, what: 'both' })
      )
      if (!res.ok) {
        setError(res.message)
        return
      }
      if (res.data.action !== 'imported') {
        setError(res.data.error ?? res.data.action)
        return
      }
      const loaded = await loadTree(movie.id)
      if ('tree' in loaded) {
        setTree(loaded.tree)
        setDirty(false)
      }
      setError([res.data.note, ...(res.data.notes ?? [])].filter(Boolean).join(' '))
    } finally {
      setBusy(null)
    }
  }
  async function handleExport() {
    if (!tree) return
    setBusy('export')
    setError(null)
    const res = await exportScreenplay(movie, tree)
    setBusy(null)
    if ('error' in res) {
      setError(res.error)
      return
    }
    setExported(res.text)
    setDirty(false)
    setNote(`Screenplay written — ${res.bytes} bytes.`)
  }

  async function handleScenes() {
    setBusy('scenes')
    setRun(null)
    setRun(await runSceneImport(true))
    setBusy(null)
  }

  async function handleBible() {
    setBusy('bible')
    setError(null)
    const res = await proposeBible(movie.id)
    setBusy(null)
    if ('error' in res) {
      setError(res.error)
      return
    }
    setBible(res)
  }

  async function handleCommitBible() {
    if (!bible) return
    setBusy('commit-bible')
    const res = await commitBible(movie, bible)
    setBusy(null)
    if ('error' in res) {
      setError(res.error)
      return
    }
    setBible(null)
    const n = (bible.props ?? []).length
    setNote(
      n
        ? `Characters, locations and ${n} prop${n === 1 ? '' : 's'} saved. Render their sheets in Props & Wardrobe - words alone never hold an object still.`
        : 'Characters and locations saved.'
    )
  }

  async function handleOrchestrate() {
    setBusy('orchestrate')
    setRun(null)
    setRun(await startOrchestration('A1'))
    setBusy(null)
  }

  if (loading) return <p>Loading screenplay…</p>

  if (!tree) {
    return (
      <div>
        <h3>Screenplay</h3>
        {error && <p className="error">{error}</p>}
      </div>
    )
  }

  const beatCount = flatten(tree).length
  const isEmpty = tree.acts.length === 0

  return (
    <div className="screenplay">
      <div className="screenplay-toolbar">
        <h3>Screenplay — {movie.title}</h3>
        <span className="screenplay-count">
          {tree.acts.length} act{tree.acts.length === 1 ? '' : 's'} · {countScenes(tree)} scenes · {beatCount} beats
        </span>
        <button type="button" disabled={!dirty || saving} onClick={handleSave}>
          {saving ? 'Saving…' : dirty ? 'Save' : 'Saved'}
        </button>
      </div>

      {error && <p className="error">{error}</p>}
      {note && <p className="run-status-ok">{note}</p>}

      <details className="screenplay-writein screenplay-writer" open={isEmpty}>
        <summary>Have it written for you</summary>
        <p className="empty">
          Describe the film in a line or in a page. It comes back as a full screenplay you can keep
          talking to - "make it darker", "lose the brother", "set it in 1962". When it looks right,
          send it down to the breakdown below. Nothing is saved until you press Save.
        </p>
        <WriterChat
          flowId={import.meta.env.VITE_SCREENPLAY_WRITER_ID}
          roleLabel="Screenwriter"
          emptyHint="Nothing written yet."
          placeholder="e.g. a lighthouse keeper finds a radio that only receives tomorrow"
          starters={[
            'A short film about a lighthouse keeper who receives tomorrow on an old radio',
            'A three-act thriller set in a hospital during a blackout'
          ]}
          docLabel="Use for breakdown"
          extractDoc={(payload, reply) => (payload.isScreenplay ? reply : '')}
          onUseDoc={(doc) => {
            setProse(doc)
            setNote('Screenplay dropped into the breakdown box below.')
          }}
        />
      </details>

      <details className="screenplay-writein" open={isEmpty}>
        <summary>Write it out and let it be broken down</summary>
        <p className="empty">
          Describe the story however you like - a paragraph, an outline, a chapter. It comes back as
          acts, scenes and beats you can then edit. Nothing is saved until you press Save.
        </p>
        {/* The screenplay is usually already uploaded - it is what the Beat
            Generator reads - but until now it could only be viewed from the
            Documents tab, never pulled in here. Loads into the box rather than
            breaking down straight away, so the wrong one is obvious first. */}
        {/* A breakdown read off a film, rather than a document. Same place,
            because it is the same job: getting a script in here to edit. */}
        <div className="screenplay-sublabel">
          Import a shot breakdown
          <div>
            <button
              type="button"
              disabled={busy !== null}
              onClick={importBreakdown}
              title="Choose the shots.json of a breakdown made in the Tools tab. Writes its beats and a director plan carrying that film’s coverage, cut for cut."
            >
              {busy === 'breakdown' ? 'Importing…' : 'Choose a breakdown…'}
            </button>
          </div>
        </div>
        {docs.length > 0 && (
          <div className="screenplay-sublabel">
            Import the screenplay already in Documents
            <div>
              {docs.map((d) => (
                <button
                  type="button"
                  key={d.id}
                  disabled={busy !== null}
                  onClick={() => loadFromDocuments(d)}
                >
                  {busy === 'import' ? 'Reading…' : d.original_filename}
                </button>
              ))}
            </div>
          </div>
        )}

        <textarea
          rows={7}
          placeholder="A hacker breaks into a bank vault from a basement full of old computers..."
          value={prose}
          onChange={(e) => setProse(e.target.value)}
        />
        <button type="button" disabled={busy === 'breakdown' || !prose.trim()} onClick={handleBreakDown}>
          {busy === 'breakdown' ? 'Breaking it down…' : 'Break it down'}
        </button>
      </details>

      {/* A book is too long for one breakdown, so it goes through a chapter at
          a time. Splitting is shown before anything runs, because a forty-
          chapter book is forty model calls and you should see that first. */}
      <details className="screenplay-writein">
        <summary>Book to screenplay</summary>
        <p className="empty">
          Turn a whole book into a screenplay. It is cut into chapters and converted one at a time,
          then saved as this movie's screenplay document. Everything lands in one act — act structure
          in an adaptation is yours to decide, and nothing downstream depends on it.
        </p>

        {allDocs.length === 0 && <p className="empty">No documents on this movie yet.</p>}
        <div>
          {allDocs.map((d) => (
            <button
              type="button"
              key={d.id}
              disabled={busy !== null}
              onClick={() => planBook(d)}
            >
              {busy === 'book-read' ? 'Reading…' : `${d.original_filename} (${d.kind})`}
            </button>
          ))}
        </div>

        {book && (
          <div className="screenplay-bible-row">
            <strong>
              {book.from} — {book.chunks.length} chapter{book.chunks.length === 1 ? '' : 's'}
            </strong>
            <p className="empty">
              {book.chunks.slice(0, 6).map((c) => c.label).join(' · ')}
              {book.chunks.length > 6 ? ` · … and ${book.chunks.length - 6} more` : ''}
            </p>
            <p className="empty">
              That is {book.chunks.length} model call{book.chunks.length === 1 ? '' : 's'}. You can stop
              part way and keep what has converted.
            </p>
            {busy === 'book' ? (
              <>
                <p className="run-status-ok">
                  {bookAt
                    ? `Chapter ${bookAt.index + 1} of ${bookAt.total} — ${bookAt.label} — ${bookAt.scenes} scenes so far`
                    : 'Starting…'}
                </p>
                <button type="button" onClick={() => (stopBook.current = true)}>
                  Stop
                </button>
              </>
            ) : (
              <>
                <button type="button" onClick={convertBook}>
                  Convert {book.chunks.length} chapter{book.chunks.length === 1 ? '' : 's'}
                </button>
                <button type="button" onClick={() => setBook(null)}>
                  Cancel
                </button>
              </>
            )}
          </div>
        )}
      </details>

      {isEmpty && (
        <div className="screenplay-empty">
          <p className="empty">Or start from nothing.</p>
          <button type="button" onClick={() => change(newScreenplay())}>
            Start with Act 1, Scene 1, Beat 1
          </button>
        </div>
      )}

      {tree.acts.map((act, ai) => (
        <div className="screenplay-act" key={ai}>
          <div className="screenplay-act-header">
            <strong>Act {ai + 1}</strong>
            <span className="screenplay-tools">
              <button type="button" title="Move act up" onClick={() => change(moveAct(tree, ai, -1))}>↑</button>
              <button type="button" title="Move act down" onClick={() => change(moveAct(tree, ai, 1))}>↓</button>
              <button type="button" onClick={() => change(addScene(tree, ai))}>+ scene</button>
              <button type="button" className="danger" onClick={() => change(deleteAct(tree, ai))}>delete act</button>
            </span>
          </div>

          {act.scenes.map((scene, si) => (
            <div className="screenplay-scene" key={si}>
              <div className="screenplay-scene-header">
                <span className="badge">S{scene.beats[0]?.scene_number ?? '?'}</span>
                <select
                  value={scene.int_ext ?? 'INT'}
                  onChange={(e) => change(updateScene(tree, ai, si, { int_ext: e.target.value }))}
                >
                  <option>INT</option>
                  <option>EXT</option>
                  <option>INT/EXT</option>
                </select>
                <input
                  className="screenplay-location"
                  placeholder="LOCATION"
                  value={scene.location ?? ''}
                  onChange={(e) => change(updateScene(tree, ai, si, { location: e.target.value }))}
                />
                <input
                  className="screenplay-time"
                  placeholder="DAY"
                  value={scene.time_of_day ?? ''}
                  onChange={(e) => change(updateScene(tree, ai, si, { time_of_day: e.target.value }))}
                />
                <span className="screenplay-tools">
                  <button type="button" title="Move scene up" onClick={() => change(moveScene(tree, ai, si, -1))}>↑</button>
                  <button type="button" title="Move scene down" onClick={() => change(moveScene(tree, ai, si, 1))}>↓</button>
                  <button type="button" onClick={() => change(addBeat(tree, ai, si))}>+ beat</button>
                  <button type="button" className="danger" onClick={() => change(deleteScene(tree, ai, si))}>×</button>
                </span>
              </div>

              {scene.beats.map((beat, bi) => {
                const key = `${ai}-${si}-${bi}`
                const open = openBeat === key
                return (
                  <div className="screenplay-beat" key={key}>
                    <div className="screenplay-beat-bar">
                      <button
                        type="button"
                        className="screenplay-beat-toggle"
                        onClick={() => setOpenBeat(open ? '' : key)}
                      >
                        <span className="badge">{beat.beat_code}</span>
                        <span className="screenplay-beat-summary">
                          {beat.summary || beat.action_text || <em>empty beat</em>}
                        </span>
                      </button>
                      <span className="screenplay-tools">
                        <button type="button" title="Move beat up" onClick={() => change(moveBeat(tree, ai, si, bi, -1))}>↑</button>
                        <button type="button" title="Move beat down" onClick={() => change(moveBeat(tree, ai, si, bi, 1))}>↓</button>
                        <button type="button" title="Insert a beat below" onClick={() => change(addBeat(tree, ai, si, bi + 1))}>+</button>
                        <button type="button" className="danger" onClick={() => change(deleteBeat(tree, ai, si, bi))}>×</button>
                      </span>
                    </div>

                    {open && (
                      <div className="screenplay-beat-body">
                        <label>
                          What happens
                          <textarea
                            rows={4}
                            placeholder="Action. What we see."
                            value={beat.action_text ?? ''}
                            onChange={(e) => change(updateBeat(tree, ai, si, bi, { action_text: e.target.value }))}
                          />
                        </label>
                        <label>
                          Summary
                          <input
                            placeholder="One line - what this beat is"
                            value={beat.summary}
                            onChange={(e) => change(updateBeat(tree, ai, si, bi, { summary: e.target.value }))}
                          />
                        </label>
                        <button
                          type="button"
                          disabled={busy === `enhance-${ai}-${si}-${bi}`}
                          onClick={() => handleEnhance(ai, si, bi)}
                        >
                          {busy === `enhance-${ai}-${si}-${bi}` ? 'Enhancing…' : 'Enhance this beat'}
                        </button>

                        <div className="screenplay-dialogue-block">
                          <span className="screenplay-sublabel">Dialogue</span>
                          {beat.dialogue.map((d, di) => (
                            <div className="screenplay-dialogue-row" key={di}>
                              <input
                                className="screenplay-cue"
                                placeholder="CHARACTER"
                                value={d.character}
                                onChange={(e) => {
                                  const next = beat.dialogue.map((x, i) =>
                                    i === di ? { ...x, character: e.target.value } : x
                                  )
                                  change(updateBeat(tree, ai, si, bi, { dialogue: next }))
                                }}
                              />
                              <input
                                className="screenplay-paren"
                                placeholder="(how)"
                                value={d.parenthetical ?? ''}
                                onChange={(e) => {
                                  const next = beat.dialogue.map((x, i) =>
                                    i === di ? { ...x, parenthetical: e.target.value } : x
                                  )
                                  change(updateBeat(tree, ai, si, bi, { dialogue: next }))
                                }}
                              />
                              <input
                                className="screenplay-line"
                                placeholder="What they say"
                                value={d.line}
                                onChange={(e) => {
                                  const next = beat.dialogue.map((x, i) =>
                                    i === di ? { ...x, line: e.target.value } : x
                                  )
                                  change(updateBeat(tree, ai, si, bi, { dialogue: next }))
                                }}
                              />
                              <button
                                type="button"
                                className="danger"
                                onClick={() => {
                                  const next = beat.dialogue.filter((_, i) => i !== di)
                                  change(updateBeat(tree, ai, si, bi, { dialogue: next }))
                                }}
                              >
                                ×
                              </button>
                            </div>
                          ))}
                          <button
                            type="button"
                            onClick={() => {
                              const next = [...beat.dialogue, { character: '', parenthetical: '', line: '' }]
                              change(updateBeat(tree, ai, si, bi, { dialogue: next }))
                            }}
                          >
                            + line
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          ))}
        </div>
      ))}

      {!isEmpty && (
        <button type="button" onClick={() => change(addAct(tree))}>
          + Add act
        </button>
      )}

      {!isEmpty && (
        <div className="screenplay-finish">
          <h4>Finish</h4>
          <p className="empty">
            In order: write the screenplay file, roll the beats up into scenes, work out the
            characters and locations, then hand it to the pipeline.
          </p>

          <div className="screenplay-finish-row">
            <button type="button" disabled={busy === 'export' || dirty} onClick={handleExport}>
              {busy === 'export' ? 'Writing…' : '1. Write screenplay file'}
            </button>
            {dirty && <span className="screenplay-count">Save first</span>}

            <button type="button" disabled={busy === 'scenes'} onClick={handleScenes}>
              {busy === 'scenes' ? 'Rolling up…' : '2. Build scenes'}
            </button>

            <button type="button" disabled={busy === 'bible'} onClick={handleBible}>
              {busy === 'bible' ? 'Working it out…' : '3. Characters, locations & props'}
            </button>

            <button type="button" disabled={busy === 'orchestrate'} onClick={handleOrchestrate}>
              {busy === 'orchestrate' ? 'Starting…' : '4. Start orchestration'}
            </button>
          </div>

          {run && run.state !== 'running' && (
            <p className={run.state === 'error' ? 'error' : 'run-status-ok'}>{run.message.slice(0, 600)}</p>
          )}

          {bible && (
            <div className="screenplay-bible">
              <h4>Proposed — review before saving</h4>
              {bible.characters.map((c, i) => (
                <div className="screenplay-bible-row" key={c.name}>
                  <strong>{c.name}</strong>
                  {c.inferred && <span className="badge unresolved">inferred</span>}
                  <textarea
                    rows={3}
                    value={c.visual_anchor}
                    onChange={(e) => {
                      const next = { ...bible }
                      next.characters = bible.characters.map((x, j) =>
                        j === i ? { ...x, visual_anchor: e.target.value } : x
                      )
                      setBible(next)
                    }}
                  />
                </div>
              ))}
              {bible.locations.map((l, i) => (
                <div className="screenplay-bible-row" key={`${l.act_number}-${l.scene_number}`}>
                  <strong>
                    A{l.act_number}S{l.scene_number}
                  </strong>
                  <textarea
                    rows={3}
                    value={l.location_description}
                    onChange={(e) => {
                      const next = { ...bible }
                      next.locations = bible.locations.map((x, j) =>
                        j === i ? { ...x, location_description: e.target.value } : x
                      )
                      setBible(next)
                    }}
                  />
                </div>
              ))}
              {/* Props and wardrobe. Scale is editable on its own line and not
                  buried in the description because it is the field that decides
                  whether a prop holds still: "a glowing crystal" says nothing
                  about size, so the same object comes out different in every
                  shot. Aliases are shown for the same reason - matched on the
                  canonical name alone, a prop binds to almost nothing. */}
              {(bible.props ?? []).map((p, i) => (
                <div className="screenplay-bible-row" key={`prop-${p.name}`}>
                  <strong>{p.name}</strong>
                  <span className="badge">{p.kind}</span>
                  <textarea
                    rows={2}
                    value={p.description}
                    onChange={(e) => {
                      const next = { ...bible }
                      next.props = bible.props.map((x, j) =>
                        j === i ? { ...x, description: e.target.value } : x
                      )
                      setBible(next)
                    }}
                  />
                  <label className="screenplay-sublabel">
                    Scale — how big, against something known
                    <input
                      value={p.scale_note}
                      placeholder="fits in a cupped hand"
                      onChange={(e) => {
                        const next = { ...bible }
                        next.props = bible.props.map((x, j) =>
                          j === i ? { ...x, scale_note: e.target.value } : x
                        )
                        setBible(next)
                      }}
                    />
                  </label>
                  <label className="screenplay-sublabel">
                    Also called
                    <input
                      value={(p.aliases ?? []).join(', ')}
                      placeholder="crystal, wish star crystal"
                      onChange={(e) => {
                        const next = { ...bible }
                        next.props = bible.props.map((x, j) =>
                          j === i
                            ? { ...x, aliases: e.target.value.split(',').map((a) => a.trim()).filter(Boolean) }
                            : x
                        )
                        setBible(next)
                      }}
                    />
                  </label>
                  <button
                    type="button"
                    onClick={() => {
                      const next = { ...bible }
                      next.props = bible.props.filter((_, j) => j !== i)
                      setBible(next)
                    }}
                  >
                    Drop
                  </button>
                </div>
              ))}
              <button type="button" disabled={busy === 'commit-bible'} onClick={handleCommitBible}>
                {busy === 'commit-bible'
                  ? 'Saving…'
                  : `Save characters, locations${(bible.props ?? []).length ? ' & props' : ''}`}
              </button>
              <button type="button" onClick={() => setBible(null)}>Discard</button>
            </div>
          )}

          {exported && (
            <details className="screenplay-preview">
              <summary>Screenplay file</summary>
              <pre className="preview-text">{exported}</pre>
            </details>
          )}
        </div>
      )}
    </div>
  )
}
