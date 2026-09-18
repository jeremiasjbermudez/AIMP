import { useEffect, useRef, useState } from 'react'
import { insforge, type Movie, type Character, comfyViewUrl, type CharacterImage } from './insforge'
import { uploadToMovie, IMAGE_ACCEPT } from './storage'
import { uploadImageToProject } from './frames'
import { signIn } from './session'
import { triggerFlow, type RunStatus } from './flowise'
import { WriterChat } from './ui/WriterChat'
import { deleteAssetFiles, deleteStorageObjects, keptNote } from './assets'
import { X } from 'lucide-react'
import { LoraNameSelect } from './ui/LoraPicker'
import { Select } from './ui/Select'



export function CharactersPanel({ movie }: { movie: Movie }) {
  const [characters, setCharacters] = useState<Character[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  // Which character's description is open for editing, and the draft text.
  const [editingDesc, setEditingDesc] = useState<string | null>(null)
  const [draftAnchor, setDraftAnchor] = useState('')
  const [draftClothing, setDraftClothing] = useState('')
  const [savingDesc, setSavingDesc] = useState(false)
  const [editing, setEditing] = useState<Record<string, { loraPath: string; strengthModel: string; strengthClip: string }>>({})
  const [saving, setSaving] = useState<string | null>(null)
  const [generating, setGenerating] = useState<string | null>(null)
  const [importing, setImporting] = useState(false)
  const [importStatus, setImportStatus] = useState<RunStatus | null>(null)
  const [genStatus, setGenStatus] = useState<Record<string, RunStatus>>({})
  // Images are grouped into versions so a regenerate can sit beside the last
  // attempt instead of replacing it, and so your own images can be a version too.
  const [images, setImages] = useState<Record<string, CharacterImage[]>>({})
  const [previews, setPreviews] = useState<Record<string, string>>({})
  const fetchedKeys = useRef<Set<string>>(new Set())
  const madeUrls = useRef<string[]>([])
  const [uploading, setUploading] = useState<string | null>(null)
  const [busyImage, setBusyImage] = useState<string | null>(null)
  const [lightbox, setLightbox] = useState<{ src: string; label: string } | null>(null)
  // Characters could only ever arrive from the bible import; there was no way
  // to add one by hand or remove one that was wrong.
  const [newName, setNewName] = useState('')
  const [newGender, setNewGender] = useState('')
  const [adding, setAdding] = useState(false)
  // QA reference shots: measured framing, generated from one photo.
  const [qaBusy, setQaBusy] = useState<string | null>(null)
  const [qaNote, setQaNote] = useState<Record<string, string>>({})
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)
  async function loadCharacters() {
    setLoading(true)
    const { data, error } = await insforge.database
      .from('characters')
      .select('*')
      .eq('movie_id', movie.id)
      .order('name', { ascending: true })
    if (error) setError(error.message)
    else {
      const rows = (data ?? []) as Character[]
      setCharacters(rows)
      await loadImages(rows)
      setEditing(
        Object.fromEntries(
          rows.map((c) => [
            c.id,
            {
              loraPath: c.lora_path ?? '',
              strengthModel: String(c.lora_strength_model),
              strengthClip: String(c.lora_strength_clip)
            }
          ])
        )
      )
    }
    setLoading(false)
  }

  useEffect(() => {
    loadCharacters()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [movie.id])

  // Characters have to exist before anything per-character can be offered, and
  // on a new movie nothing has run yet to create them. The bible is the one
  // source that already names them, so it seeds the table directly.
  async function loadImages(chars: Character[]) {
    const ids = chars.map((c) => c.id)
    if (ids.length === 0) {
      setImages({})
      return
    }
    const { data } = await insforge.database
      .from('character_images')
      .select('*')
      .filter('character_id', 'in', `(${ids.join(',')})`)
      .order('version', { ascending: true })
    const grouped: Record<string, CharacterImage[]> = {}
    for (const img of (data ?? []) as CharacterImage[]) {
      grouped[img.character_id] = [...(grouped[img.character_id] ?? []), img]
    }
    setImages(grouped)
  }

  // Generated images live in ComfyUI's input folder and are served by its /view
  // endpoint. Uploaded ones live in the movie's bucket, which needs the signed-in
  // session, so those are fetched through the SDK and shown as blob URLs.
  //
  // Fetch each key once; revoke only on unmount. Revoking on every re-run would
  // kill URLs still on screen, since `images` gets a new identity on each reload.
  useEffect(() => {
    const pending = Object.values(images)
      .flat()
      .filter((i) => i.storage_key && !fetchedKeys.current.has(i.storage_key))
      .map((i) => i.storage_key as string)
    if (pending.length === 0) return
    let cancelled = false
    ;(async () => {
      for (const key of pending) {
        if (cancelled) break
        fetchedKeys.current.add(key)
        let { data, error: dlError } = await insforge.storage.from(movie.bucket_name).download(key)
        if (dlError && /permission|unauthor|forbidden|token/i.test(dlError.message)) {
          await signIn()
          ;({ data, error: dlError } = await insforge.storage.from(movie.bucket_name).download(key))
        }
        if (cancelled) break
        if (dlError || !data) {
          fetchedKeys.current.delete(key)
          // Say so. A silently blank thumbnail is indistinguishable from a
          // photo that was never uploaded.
          setError(`Could not load the photo for this character: ${dlError?.message ?? 'not found'}`)
          continue
        }
        const url = URL.createObjectURL(data)
        madeUrls.current.push(url)
        setPreviews((prev) => ({ ...prev, [key]: url }))
      }
    })()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [images, movie.bucket_name])

  useEffect(() => {
    const urls = madeUrls.current
    return () => urls.forEach((u) => URL.revokeObjectURL(u))
  }, [])

  // The row id is the cache key: regenerating a version deletes these rows and
  // inserts new ones, so the URL changes exactly when the pixels do.
  //
  // image_path first now that uploads have one: it needs no auth, no blob
  // download and no object URL to revoke. storage_key stays as the fallback for
  // rows uploaded before the project copy existed.
  const srcOf = (img: CharacterImage) =>
    img.image_path
      ? comfyViewUrl(img.image_path, img.id)
      : img.storage_key
        ? previews[img.storage_key] ?? ''
        : ''

  const versionsOf = (characterId: string) => {
    const list = images[characterId] ?? []
    const byVersion = new Map<number, CharacterImage[]>()
    for (const img of list) {
      byVersion.set(img.version, [...(byVersion.get(img.version) ?? []), img])
    }
    return [...byVersion.entries()].sort((a, b) => a[0] - b[0])
  }

  const nextVersion = (characterId: string) => {
    const list = images[characterId] ?? []
    return list.reduce((max, i) => Math.max(max, i.version), 0) + 1
  }

  async function handleDeleteImage(img: CharacterImage) {
    setBusyImage(img.id)
    // Row first, then the file and any uploaded original. The delete flow keeps
    // a file another row still points at, so a shot used as a sheet's source
    // survives.
    const { error: delError } = await insforge.database.from('character_images').delete().eq('id', img.id)
    if (delError) setError(delError.message)
    else {
      const r = await deleteAssetFiles([img.image_path])
      await deleteStorageObjects(movie.bucket_name, [img.storage_key])
      const note = keptNote(r)
      if (note) setError(note)
      setImages((prev) => ({
        ...prev,
        [img.character_id]: (prev[img.character_id] ?? []).filter((i) => i.id !== img.id)
      }))
    }
    setBusyImage(null)
  }

  async function handleDeleteVersion(characterId: string, version: number) {
    setBusyImage(`${characterId}-v${version}`)
    // Collect the file locations before the rows go.
    const { data: doomed } = await insforge.database
      .from('character_images')
      .select('image_path,storage_key')
      .eq('character_id', characterId)
      .eq('version', version)
    const { error: delError } = await insforge.database
      .from('character_images')
      .delete()
      .eq('character_id', characterId)
      .eq('version', version)
    if (delError) setError(delError.message)
    else {
      const rows = (doomed ?? []) as { image_path: string | null; storage_key: string | null }[]
      const r = await deleteAssetFiles(rows.map((d) => d.image_path))
      await deleteStorageObjects(movie.bucket_name, rows.map((d) => d.storage_key))
      const note = keptNote(r)
      if (note) setError(note)
      setImages((prev) => ({
        ...prev,
        [characterId]: (prev[characterId] ?? []).filter((i) => i.version !== version)
      }))
    }
    setBusyImage(null)
  }

  // Your own images become their own version, so they sit alongside the
  // generated ones rather than competing with them.
  async function handleUpload(c: Character, files: FileList) {
    setUploading(c.id)
    setError(null)
    const version = nextVersion(c.id)
    const rows: Record<string, unknown>[] = []
    for (const file of Array.from(files)) {
      // Two homes, on purpose. Storage keeps the pristine original; the project
      // folder holds the copy the rest of the pipeline can actually reach. An
      // upload that only had a storage_key was invisible to ComfyUI and to
      // every image picker - they build their lists from paths - so a photo you
      // added could not be used as a reference anywhere.
      const up = await uploadToMovie(movie, `character-images/${c.name}`, file)
      if ('error' in up) {
        setError(up.error)
        setUploading(null)
        return
      }
      const safe = file.name.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/_+/g, '_').slice(-60)
      const into = await uploadImageToProject(
        movie,
        file,
        `_CharacterRefs/${c.name}`,
        `uploaded_${Date.now()}_${safe}`
      )
      if ('error' in into) {
        setError(into.error)
        setUploading(null)
        return
      }
      rows.push({
        character_id: c.id,
        kind: file.name.replace(/\.[^.]+$/, '').slice(0, 60),
        image_path: into.image_path,
        storage_key: up.key,
        source: 'uploaded',
        version
      })
    }
    if (rows.length > 0) {
      const { error: insertError } = await insforge.database.from('character_images').insert(rows)
      if (insertError) setError(insertError.message)
    }
    await loadImages(characters)
    setUploading(null)
  }

  async function handleAddCharacter() {
    const name = newName.trim().toUpperCase()
    if (!name) return
    setAdding(true)
    setError(null)
    if (characters.some((c) => c.name.toUpperCase() === name)) {
      setError(`There is already a character called ${name}.`)
      setAdding(false)
      return
    }
    // lora strengths are left to the column defaults (1 and 0.31); those are
    // the same values the editor below starts a character at.
    const { error: insertError } = await insforge.database
      .from('characters')
      .insert([{ movie_id: movie.id, name, gender: newGender.trim() || null }])
    if (insertError) setError(insertError.message)
    else {
      setNewName('')
      setNewGender('')
    }
    await loadCharacters()
    setAdding(false)
  }

  async function handleDeleteCharacter(c: Character) {
    setError(null)
    // character_images cascades in the database. Documents attached to this
    // character do not, so they are cleared here rather than left dangling.
    await insforge.database.from('documents').delete().eq('character_id', c.id)
    const { error: delError } = await insforge.database.from('characters').delete().eq('id', c.id)
    if (delError) setError(delError.message)
    setConfirmDelete(null)
    await loadCharacters()
  }

  // The chat only proposes. Committing goes through the same path a hand-written
  // bible takes - saved as the movie's character_bible document, then imported -
  // so there is one reconciliation rule, not two.
  async function handleUseBible(bible: string) {
    setImporting(true)
    setImportStatus({ state: 'running', message: '' })
    const name = `bible-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.txt`
    const file = new File([bible], name, { type: 'text/plain' })
    const key = `character_bible/${Date.now()}-${name}`
    const { data: up, error: upError } = await insforge.storage.from(movie.bucket_name).upload(key, file)
    if (upError || !up) {
      setImportStatus({ state: 'error', message: upError?.message ?? 'Could not save the bible.' })
      setImporting(false)
      return
    }
    const { error: docError } = await insforge.database.from('documents').insert([
      {
        movie_id: movie.id,
        kind: 'character_bible',
        original_filename: name,
        storage_key: up.key,
        url: up.url,
        mime_type: 'text/plain',
        size_bytes: file.size
      }
    ])
    if (docError) {
      setImportStatus({ state: 'error', message: docError.message })
      setImporting(false)
      return
    }
    setImporting(false)
    // The importer reads the newest character_bible document, which is now this
    // one, so the existing handler finishes the job unchanged.
    await handleImportFromBible()
  }

  // Turns the newest uploaded photo into the four angles face QA needs. The
  // existing reference kinds were framed for a human eye: measured against
  // buffalo_l, the turnaround gives a 53px face and the "macro extreme" closeup
  // gives none at all. These land around 320px and agree with each other.
  // Marks a character as never seen unmasked. It changes nothing about how their
  // references are made - it only tells Face QA to stop scoring likeness, which
  // is meaningless behind a cowl, and check whether the mask stayed on instead.
  // The medium every reference prompt for this character will assert. It is not
  // cosmetic: "A photograph of the same character" beats the reference latent,
  // so an anime character rendered under the photographic wording comes back as
  // a live person.
  // What this character IS, which the prompt builder reads instead of guessing.
  //
  // It used to work this out by pattern-matching the written description - a list
  // of words for people, a regex for hair, another for garments. Anything the
  // list had not met was introduced as "the character", which is no instruction
  // at all, and the clothing rule would discard the phrase naming what it
  // actually was. Stated once here, it cannot be got wrong later.
  async function handleKind(c: Character, kind: Character['kind']) {
    setError(null)
    setCharacters((prev) => prev.map((x) => (x.id === c.id ? { ...x, kind } : x)))
    const { error: upError } = await insforge.database
      .from('characters')
      .update({ kind })
      .eq('id', c.id)
    if (upError) {
      setError(upError.message)
      await loadCharacters()
    }
  }
  async function handleRenderStyle(c: Character, style: Character['render_style']) {
    setError(null)
    setCharacters((prev) => prev.map((x) => (x.id === c.id ? { ...x, render_style: style } : x)))
    const { error: upError } = await insforge.database
      .from('characters')
      .update({ render_style: style })
      .eq('id', c.id)
    if (upError) {
      setError(upError.message)
      await loadCharacters()
    }
  }

  /**
   * Edit the imported description.
   *
   * `visual_anchor` and `clothing` arrive from the character bible import, and
   * whatever the importer made of the prose is what every render of that
   * character is then built from - the generator, the QA shots and the face fix
   * all read them. So a bad import is not cosmetic: it propagates. Being able
   * to correct it here is the difference between fixing one field and
   * re-importing the bible.
   *
   * `visual_anchor_source` is set to 'manual' on save so the importer's
   * skip-if-already-set logic does not quietly overwrite the correction on the
   * next run.
   */
  function startEditDesc(c: Character) {
    setEditingDesc(c.id)
    setDraftAnchor(c.visual_anchor ?? '')
    setDraftClothing(c.clothing ?? '')
    setError(null)
  }

  async function saveDesc(c: Character) {
    setSavingDesc(true)
    const anchor = draftAnchor.trim()
    const clothing = draftClothing.trim()
    const { error: upError } = await insforge.database
      .from('characters')
      .update({
        visual_anchor: anchor || null,
        clothing: clothing || null,
        visual_anchor_source: 'manual'
      })
      .eq('id', c.id)
    setSavingDesc(false)
    if (upError) {
      setError(upError.message)
      return
    }
    setCharacters((prev) =>
      prev.map((x) =>
        x.id === c.id ? { ...x, visual_anchor: anchor || null, clothing: clothing || null } : x
      )
    )
    setEditingDesc(null)
  }

  async function handleFaceCovered(c: Character, covered: boolean) {
    setError(null)
    setCharacters((prev) => prev.map((x) => (x.id === c.id ? { ...x, face_covered: covered } : x)))
    const { error: upError } = await insforge.database
      .from('characters')
      .update({ face_covered: covered })
      .eq('id', c.id)
    if (upError) {
      setError(upError.message)
      await loadCharacters()
    }
  }

  async function handleQaShots(c: Character, mode: 'qa' | 'sheet' = 'qa') {
    setQaBusy(c.id)
    setQaNote((p) => ({
      ...p,
      [c.id]:
        mode === 'sheet'
          ? 'Drawing the reference sheet — one tall multi-view image, this takes a few minutes.'
          : 'Generating four angles — this takes a few minutes.'
    }))
    const r = await triggerFlow(import.meta.env.VITE_CHARACTER_QA_SHOTS_ID, { characterId: c.id, mode })
    let msg = r.message
    if (r.state === 'done') {
      try {
        const p = JSON.parse(r.message)
        msg = p.error
          ? p.error
          : `Made ${(p.created || []).length} QA shots as version ${p.version}.` +
            (p.failed && p.failed.length ? ` ${p.failed.length} failed.` : '')
      } catch {
        /* leave the raw text */
      }
    }
    setQaNote((p) => ({ ...p, [c.id]: msg }))
    setQaBusy(null)
    await loadCharacters()
  }

  async function handleImportFromBible() {
    setImporting(true)
    setImportStatus({ state: 'running', message: '' })
    const result = await triggerFlow(import.meta.env.VITE_CHARACTER_BIBLE_IMPORT_ID, '')
    let message = result.message
    if (result.state === 'done') {
      try {
        const p = JSON.parse(result.message)
        message = p.error
          ? p.error
          : `${p.charactersInBible} in bible — ${p.created.length} created, ${p.updated.length} updated, ${p.skipped.length} left alone.`
        if (p.error) result.state = 'error'
      } catch {
        /* leave the raw text */
      }
    }
    setImportStatus({ state: result.state, message })
    setImporting(false)
    loadCharacters()
  }

  async function handleSaveLora(characterId: string) {
    setSaving(characterId)
    await saveLora(characterId)
    setSaving(null)
    loadCharacters()
  }

  // Returns false if the edits were rejected, so Generate can stop rather than
  // running the flow against a stale lora - the whole point of setting one
  // before generating.
  async function saveLora(characterId: string): Promise<boolean> {
    const edit = editing[characterId]
    if (!edit) return true
    setError(null)

    const strengthModel = parseFloat(edit.strengthModel)
    const strengthClip = parseFloat(edit.strengthClip)
    if (Number.isNaN(strengthModel) || Number.isNaN(strengthClip)) {
      setError('LoRA strength values must be numbers.')
      return false
    }

    // Windows Explorer's "Copy as path" wraps the result in literal double
    // quotes (e.g. "C:\...\Clem-Klein.safetensors") - a very likely source
    // for this field - which ComfyUI would then fail to match against any
    // real file. Strip quotes and stray whitespace from BOTH ends
    // independently: a single unmatched quote survived the matched-pair-only
    // version and reached ComfyUI as part of the filename.
    // ComfyUI's LoraLoader also rejects an absolute path outright (verified
    // against the real server - it validates lora_name against its own
    // relative-path enum, e.g. "DH-Lora\Clem-Klein.safetensors", and 400s
    // on anything else) - strip a leading ComfyUI-root loras prefix too, so
    // either form works.
    const loraPath = edit.loraPath
      .trim()
      .replace(/^['"\s]+/, '')
      .replace(/['"\s]+$/, '')
      .replace(/^.*[\\/]models[\\/]loras[\\/]/i, '')

    const { error } = await insforge.database
      .from('characters')
      .update({
        lora_path: loraPath || null,
        lora_strength_model: strengthModel,
        lora_strength_clip: strengthClip
      })
      .eq('id', characterId)

    if (error) {
      setError(error.message)
      return false
    }
    return true
  }

  // Runs 3-Character-Generator for one character: descriptor first, then
  // reference images. Any pending edits in the LoRA fields are committed first
  // so what is on screen is what the flow reads. The LoRA path is optional -
  // left blank, the flow simply omits the LoraLoader node.
  async function handleRegenerate(c: Character) {
    // The generator writes into the version it is given, so this leaves the
    // existing images untouched and adds the new attempt alongside them.
    await handleGenerate(c, false, nextVersion(c.id))
  }

  async function handleGenerate(c: Character, descriptorOnly: boolean, targetVersion?: number) {
    setGenerating(c.id)
    setGenStatus((prev) => ({ ...prev, [c.id]: { state: 'running', message: '' } }))

    const saved = await saveLora(c.id)
    if (!saved) {
      setGenStatus((prev) => ({
        ...prev,
        [c.id]: { state: 'error', message: 'Fix the LoRA strength values first.' }
      }))
      setGenerating(null)
      return
    }

    // Without --force the flow short-circuits on any character that already has
    // a visual_anchor, which would make a re-run silently do nothing.
    const flags = [
        c.visual_anchor ? '--force' : '',
        descriptorOnly ? '--descriptor-only' : '',
        targetVersion && targetVersion > 1 ? `--version ${targetVersion}` : ''
      ]
      .filter(Boolean)
      .join(' ')
    const result = await triggerFlow(
      import.meta.env.VITE_CHARACTER_GENERATOR_ID,
      flags ? `${c.name} ${flags}` : c.name
    )
    setGenStatus((prev) => ({ ...prev, [c.id]: result }))
    setGenerating(null)
    loadCharacters()
  }

  const lightboxEl = lightbox ? (
    <div className="lightbox" onClick={() => setLightbox(null)}>
      <div className="lightbox-inner" onClick={(e) => e.stopPropagation()}>
        <img src={lightbox.src} alt={lightbox.label} />
        <div className="lightbox-bar">
          <span>{lightbox.label}</span>
          <button type="button" onClick={() => setLightbox(null)}>Close</button>
        </div>
      </div>
    </div>
  ) : null

  const importControls = (
    <div className="bible-import">
      <div className="upload-form">
        <input
          type="text"
          value={newName}
          placeholder="Character name"
          onChange={(e) => setNewName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') handleAddCharacter()
          }}
        />
        <input
          type="text"
          value={newGender}
          placeholder="Gender (optional)"
          onChange={(e) => setNewGender(e.target.value)}
        />
        <button type="button" disabled={adding || !newName.trim()} onClick={handleAddCharacter}>
          {adding ? 'Adding…' : 'Add character'}
        </button>
      </div>
      <p className="empty">
        Names are stored in upper case, matching the beat and bible format. Add one by hand, or import the
        whole cast from the character bible.
      </p>
      <button type="button" disabled={importing} onClick={handleImportFromBible}>
        {importing ? 'Importing…' : 'Load characters from bible'}
      </button>
      {importStatus && importStatus.state !== 'running' && (
        <p className={importStatus.state === 'error' ? 'error' : 'run-status-ok'}>{importStatus.message}</p>
      )}
      <div className="bible-chat">
        <h4>Ask for characters</h4>
        <p className="empty">
          It reads this movie's screenplay and the cast you already have. Ask it to add someone, change
          a look, or fill in whoever the script leaves vague - where the screenplay does not say, it
          invents something concrete rather than leaving a blank the image generator cannot use.
          Saving replaces the character bible and re-imports the cast.
        </p>
        <WriterChat
          flowId={import.meta.env.VITE_CHARACTER_BIBLE_WRITER_ID}
          payload={{ movieId: movie.id }}
          roleLabel="Character designer"
          emptyHint="Nothing proposed yet."
          placeholder="e.g. add a harbour master, and make a character older"
          starters={['Build the bible from the screenplay', 'Who is in the script but missing from the cast?']}
          docLabel="Save as the character bible"
          extractDoc={(payload) => String(payload.bible ?? '')}
          onUseDoc={handleUseBible}
        />
      </div>

    </div>
  )

  if (loading) return <p>Loading characters…</p>
  if (error && characters.length === 0) return <p className="error">{error}</p>
  if (characters.length === 0) {
    return (
      <div>
        <p className="empty">
          No characters yet for {movie.title}. Upload a character bible on the Documents tab, then load them here.
        </p>
        {importControls}
      </div>
    )
  }

  return (
    <div>
      {lightboxEl}
      {error && <p className="error">{error}</p>}
      {importControls}
      <div className="characters-list">
        {characters.map((c) => {
          const edit = editing[c.id] ?? { loraPath: '', strengthModel: '1', strengthClip: '0.31' }
          return (
            <div className="character-card" key={c.id}>
              <div className="character-card-header">
                <span className="character-name">{c.name}</span>
                {c.gender && <span className="badge">{c.gender}</span>}
                {c.visual_anchor_source && <span className="badge">{c.visual_anchor_source}</span>}
                {!c.visual_anchor && <span className="badge unresolved">unresolved</span>}
                <span className="grow" />
                {confirmDelete === c.id ? (
                  <>
                    <span className="empty">Delete {c.name} and all its images?</span>
                    <button type="button" className="danger" onClick={() => handleDeleteCharacter(c)}>
                      Delete
                    </button>
                    <button type="button" onClick={() => setConfirmDelete(null)}>
                      Cancel
                    </button>
                  </>
                ) : (
                  <button type="button" className="danger" onClick={() => setConfirmDelete(c.id)}>
                    Delete
                  </button>
                )}
              </div>
              <div className="upload-form">
                <label>
                  Is a{' '}
                  <Select
                    value={c.kind ?? 'person'}
                    onValueChange={(v) => handleKind(c, v as Character['kind'])}
                    items={[
                      { value: 'person', label: 'Person' },
                      { value: 'animal', label: 'Animal' },
                      { value: 'creature', label: 'Creature' },
                      { value: 'robot', label: 'Robot' },
                      { value: 'object', label: 'Object' }
                    ]}
                  />
                </label>
                <label>
                  Drawn as{' '}
                  <Select
                    value={c.render_style ?? 'photographic'}
                    onValueChange={(v) => handleRenderStyle(c, v as Character['render_style'])}
                    items={[
                      { value: 'photographic', label: 'Photographic' },
                      { value: 'anime', label: 'Anime' },
                      { value: 'cartoon', label: 'Cartoon' },
                      { value: '3d_animated', label: '3D animated' }
                    ]}
                  />
                </label>
                <span className="empty">
                  Sets the medium every reference prompt asserts. Leave photographic for a live
                  person; anything else here is what stops an anime character rendering as one.
                </span>
              </div>
              <label className="empty face-covered">
                <input
                  type="checkbox"
                  checked={!!c.face_covered}
                  onChange={(e) => handleFaceCovered(c, e.target.checked)}
                />{' '}
                Face is covered (mask, helmet, visor) — Face QA checks the mask stayed on
                instead of scoring the likeness
              </label>
              {/* No wardrobe picker here any more. A costume is not a property
                  of a person - it is worn by one, in a shot - so it is chosen in
                  the Director, per shot, and written back onto the beat. Picking
                  it here would have been a static answer to a question that
                  changes scene by scene. */}
              {editingDesc === c.id ? (
                <div className="desc-editor">
                  <label>
                    Look
                    <textarea
                      className="prompt-editor"
                      rows={3}
                      value={draftAnchor}
                      placeholder="How they look — face, hair, build, distinguishing features."
                      onChange={(e) => setDraftAnchor(e.target.value)}
                    />
                  </label>
                  <label>
                    Clothing
                    <textarea
                      className="prompt-editor"
                      rows={2}
                      value={draftClothing}
                      placeholder="What they wear."
                      onChange={(e) => setDraftClothing(e.target.value)}
                    />
                  </label>
                  <p className="empty">
                    Every render of {c.name} is built from these — the generator, the QA shots and
                    the face fix all read them. Keep them describing the person, not the shot.
                  </p>
                  <div className="edit-ref-actions">
                    <button type="button" disabled={savingDesc} onClick={() => saveDesc(c)}>
                      {savingDesc ? 'Saving…' : 'Save description'}
                    </button>
                    <button type="button" disabled={savingDesc} onClick={() => setEditingDesc(null)}>
                      Cancel
                    </button>
                  </div>
                </div>
              ) : (
                <>
                  {c.visual_anchor && <p className="character-descriptor">{c.visual_anchor}</p>}
                  {c.clothing && <p className="character-clothing">{c.clothing}</p>}
                  <div className="edit-ref-actions">
                    <button type="button" onClick={() => startEditDesc(c)}>
                      {c.visual_anchor || c.clothing ? 'Edit description' : 'Write a description'}
                    </button>
                  </div>
                </>
              )}

              <div className="lora-form">
                <label>
                  LoRA
                  {/* The label itself stacks (see .lora-form label), so the
                      select and its clear button share a row of their own. */}
                  <span className="lora-choice">
                    <LoraNameSelect
                      value={edit.loraPath}
                      placeholder="optional — none"
                      onPick={(name) =>
                        setEditing((prev) => ({ ...prev, [c.id]: { ...edit, loraPath: name } }))
                      }
                    />
                    {edit.loraPath && (
                      <button
                        type="button"
                        className="ref-remove"
                        title="Use no LoRA"
                        onClick={() => setEditing((prev) => ({ ...prev, [c.id]: { ...edit, loraPath: '' } }))}
                      >
                        <X size={14} />
                      </button>
                    )}
                  </span>
                </label>
                <label>
                  Strength (model)
                  <input
                    type="number"
                    step="0.01"
                    value={edit.strengthModel}
                    onChange={(e) => setEditing((prev) => ({ ...prev, [c.id]: { ...edit, strengthModel: e.target.value } }))}
                  />
                </label>
                <label>
                  Strength (clip)
                  <input
                    type="number"
                    step="0.01"
                    value={edit.strengthClip}
                    onChange={(e) => setEditing((prev) => ({ ...prev, [c.id]: { ...edit, strengthClip: e.target.value } }))}
                  />
                </label>
                <button type="button" disabled={saving === c.id || generating === c.id} onClick={() => handleSaveLora(c.id)}>
                  {saving === c.id ? 'Saving…' : 'Save'}
                </button>
                <button type="button" disabled={generating === c.id} onClick={() => handleGenerate(c, false)}>
                  {generating === c.id ? 'Generating…' : 'Generate images'}
                </button>
              </div>
              <p className="empty">
                {c.lora_path ? `Renders reference images using LoRA: ${c.lora_path}.` : 'Renders reference images. LoRA path is optional.'}
              </p>
              <div className="upload-form">
                <button
                  type="button"
                  disabled={generating === c.id || (images[c.id] ?? []).length === 0}
                  onClick={() => handleRegenerate(c)}
                >
                  {generating === c.id ? 'Working…' : `Regenerate as version ${nextVersion(c.id)}`}
                </button>
                <button
                  type="button"
                  disabled={qaBusy !== null || generating === c.id}
                  onClick={() => handleQaShots(c)}
                  title="Front, both three-quarters and a low angle, framed so the face is big enough to identify"
                >
                  {qaBusy === c.id ? 'Creating…' : 'Create QA shots'}
                </button>
                <button
                  type="button"
                  disabled={qaBusy !== null || generating === c.id}
                  onClick={() => handleQaShots(c, 'sheet')}
                  title="One tall sheet: a turnaround row, portraits, and a close-up — for a person to work from, not for face QA"
                >
                  {qaBusy === c.id ? 'Working…' : 'Generate reference sheet'}
                </button>
                <label className="empty">
                  Add your own{' '}
                  <input
                    type="file"
                    accept={IMAGE_ACCEPT}
                    multiple
                    disabled={uploading === c.id}
                    onChange={(e) => {
                      if (e.target.files && e.target.files.length) handleUpload(c, e.target.files)
                      e.target.value = ''
                    }}
                  />
                </label>
                {uploading === c.id && <span className="empty">Uploading…</span>}
              </div>
              <p className="empty">
                Regenerating keeps what you already have and adds a new version beside it, so you can compare before
                deciding. Images you add become their own version too.
              </p>
              {qaNote[c.id] && <p className="empty">{qaNote[c.id]}</p>}

              {versionsOf(c.id).map(([version, imgs]) => (
                <div className="char-version" key={version}>
                  <div className="take-head">
                    <strong>Version {version}</strong>
                    <span className="badge">{imgs[0]?.source ?? 'generated'}</span>
                    <span className="badge">{imgs.length} image{imgs.length === 1 ? '' : 's'}</span>
                    <button
                      type="button"
                      className="danger"
                      disabled={busyImage === `${c.id}-v${version}`}
                      onClick={() => handleDeleteVersion(c.id, version)}
                    >
                      Delete version
                    </button>
                  </div>
                  <div className="ref-thumbs">
                    {imgs.map((img) => {
                      const src = srcOf(img)
                      return (
                        <div className="ref-thumb selected" key={img.id}>
                          {src ? (
                            <img src={src} alt={`${c.name} ${img.kind}`} />
                          ) : (
                            <span className="ref-loading">loading…</span>
                          )}
                          <span className="ref-caption">{img.kind}</span>
                          {src && (
                            <span
                              className="ref-zoom"
                              title="View full size"
                              onClick={() => setLightbox({ src, label: `${c.name} — ${img.kind} (v${version})` })}
                            >
                              ⤢
                            </span>
                          )}
                          <span className="ref-remove" title="Delete this image" onClick={() => handleDeleteImage(img)}>
                            {busyImage === img.id ? '…' : '✕'}
                          </span>
                        </div>
                      )
                    })}
                  </div>
                </div>
              ))}
              {(images[c.id] ?? []).length === 0 && (
                <p className="empty">No images yet for {c.name}. Generate a set, or add your own.</p>
              )}
              {genStatus[c.id] && genStatus[c.id].state !== 'running' && (
                <p className={genStatus[c.id].state === 'error' ? 'error' : 'run-status-ok'}>
                  {genStatus[c.id].message}
                </p>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
