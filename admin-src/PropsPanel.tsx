import { useEffect, useState } from 'react'
import { insforge, comfyViewUrl, type Movie } from './insforge'
import { triggerFlow, parseFlowJson } from './flowise'
import { ImageSelect } from './ui/ImageSelect'
import { loadImageSources, toPickerGroups, type ImageSource } from './imageSources'
import { uploadImageToProject } from './frames'
import { Select } from './ui/Select'
import { proposeBible, commitBible, type BibleProposal } from './screenplay/api'

/**
 * Props and wardrobe - the things that are neither characters nor locations.
 *
 * The cast stay consistent because they have reference sheets. A prop has
 * nothing, so every render invents it again: the wish star crystal came out a
 * different size in every shot, and the shadow beast rendered as two different
 * animals. Words cannot fix scale - only a picture can - so a prop gets a sheet
 * the same way a character does (DIRECTOR.md 5.5b).
 */
type Prop = {
  id: string
  movie_id: string
  name: string
  kind: 'prop' | 'wardrobe'
  description: string | null
  scale_note: string | null
  image_path: string | null
  notes: string | null
  // Other words the script uses for it. Without these a prop binds to almost
  // nothing: one draft called the same object "a wish star crystal", "the
  // crystal", "the cracked crystal" and "wish star".
  aliases: string[]
  // The look this sheet is drawn in, stored per prop exactly as characters
  // store theirs. It used to be panel state, so it reset on reload and nothing
  // recorded which look a sheet had actually been rendered in.
  render_style: StyleKey
  // For a costume: who wears it. A costume is not named in the text the way a
  // prop is - the shot says BROWN, not "the radiation suit" - so without this
  // its sheet reaches almost none of the shots it belongs in.
  worn_by: string | null
}

// MiniMax's canvas, so a prop sheet can be used as a reference without being
// letterboxed on the way in.
const SHEET_W = 1344
const SHEET_H = 768

// The same prefixes the Director puts on every frame prompt. Without one the
// renderer defaults to photoreal, which is how the first wish star came back
// looking like a photograph in an anime film. A prop needs the movie's look for
// the same reason a character does.
const STYLES = {
  anime: { label: 'Anime', prefix: 'Anime screenshot, 2D cel-shaded anime, clean line art, vibrant colors.' },
  cartoon: { label: 'Cartoon', prefix: '2D cartoon still, bold outlines, flat vivid colors.' },
  animated: { label: '3D animated', prefix: '3D animated film still, stylized, soft cinematic lighting.' },
  photographic: { label: 'Photographic', prefix: 'Cinematic photograph.' }
} as const
type StyleKey = keyof typeof STYLES

export function PropsPanel({ movie }: { movie: Movie }) {
  const [props, setProps] = useState<Prop[]>([])
  const [sources, setSources] = useState<ImageSource[]>([])
  const [name, setName] = useState('')
  const [kind, setKind] = useState<'prop' | 'wardrobe'>('prop')
  const [description, setDescription] = useState('')
  const [scaleNote, setScaleNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [rendering, setRendering] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  // Defaults to whatever the cast are drawn in, so a prop matches the film
  // without being told; overridable because one prop occasionally should not.
  const [style, setStyle] = useState<StyleKey>('anime')
  // Props read out of the script, waiting to be reviewed. The same proposal the
  // Screenplay tab's "Characters, locations & props" step makes - offered here
  // too because this is where you come looking for props, and having to know it
  // lives under a screenplay step is how an empty list stays empty.
  const [found, setFound] = useState<BibleProposal['props'] | null>(null)
  // A description read back off a sheet, waiting to be approved. It replaces
  // words that are already driving renders, so it is never written straight in.
  const [read, setRead] = useState<{ id: string; name: string; description: string; scale_note: string } | null>(null)
  // The cast, for the wardrobe wearer picker.
  const [cast, setCast] = useState<string[]>([])
  // Said out loud when a description is rewritten from a new sheet, so the
  // change is never silent.
  const [note, setNote] = useState<string | null>(null)

  useEffect(() => {
    insforge.database
      .from('characters')
      .select('render_style')
      .eq('movie_id', movie.id)
      .then(({ data }) => {
        const styles = (data ?? []).map((c: { render_style?: string }) => c.render_style).filter(Boolean)
        const found = (['anime', 'cartoon', 'animated'] as const).find((k) => styles.includes(k))
        setStyle(found ?? 'photographic')
      })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [movie.id])

  async function load() {
    const { data, error: e } = await insforge.database
      .from('movie_props')
      .select('*')
      .eq('movie_id', movie.id)
      .order('kind', { ascending: true })
      .order('name', { ascending: true })
    if (e) setError(e.message)
    else setProps((data ?? []) as Prop[])
  }

  useEffect(() => {
    setError(null)
    load()
    insforge.database
      .from('characters')
      .select('name')
      .eq('movie_id', movie.id)
      .order('name', { ascending: true })
      .then(({ data }) => setCast(((data ?? []) as { name: string }[]).map((c) => c.name.toUpperCase())))
    loadImageSources(movie.id).then(setSources)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [movie.id])

  async function addProp() {
    const clean = name.trim()
    if (!clean) {
      setError('Give it the name the script uses.')
      return
    }
    setBusy(true)
    setError(null)
    const { error: e } = await insforge.database.from('movie_props').insert([
      {
        movie_id: movie.id,
        name: clean,
        kind,
        description: description.trim() || null,
        scale_note: scaleNote.trim() || null,
        render_style: style
      }
    ])
    setBusy(false)
    if (e) {
      setError(e.message)
      return
    }
    setName('')
    setDescription('')
    setScaleNote('')
    await load()
  }

  /** Read the beats and propose the props and costumes the story needs. */
  async function findInScript() {
    setBusy(true)
    setError(null)
    try {
      const res = await proposeBible(movie.id)
      if ('error' in res) {
        setError(res.error)
        return
      }
      const list = res.props ?? []
      if (!list.length) {
        setError('Nothing found. If the beats are thin on objects, there may genuinely be no props to build.')
        return
      }
      setFound(list)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  /**
   * Save the reviewed props. commitBible is reused with the other two lists
   * empty, so only props are written - matched on name AND aliases, so a second
   * run updates rather than duplicating, and a rendered sheet is never touched.
   */
  async function saveFound() {
    if (!found) return
    setBusy(true)
    setError(null)
    const res = await commitBible(movie, { characters: [], locations: [], props: found })
    setBusy(false)
    if ('error' in res) {
      setError(res.error)
      return
    }
    setFound(null)
    await load()
  }

  /**
   * Use a picture from disk as this prop's sheet.
   *
   * A sheet does not have to be generated - a photograph of the real object, or
   * a drawing made elsewhere, holds it just as still, and for something like a
   * specific car it holds it better than any prompt would.
   */
  async function uploadSheet(p: Prop, file: File) {
    setRendering(p.id)
    setError(null)
    try {
      // Named from the prop so the folder stays readable, timestamped so a
      // replacement never collides with the picture it replaces.
      const ext = (file.name.match(/\.[a-z0-9]+$/i)?.[0] || '.png').toLowerCase()
      const slug = p.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'prop'
      const up = await uploadImageToProject(movie, file, '_props', `${slug}-${Date.now()}${ext}`)
      if ('error' in up) {
        setError(`${p.name}: ${up.error}`)
        return
      }
      await patch(p, { image_path: up.image_path })
      // So the new picture is pickable elsewhere without a reload.
      loadImageSources(movie.id).then(setSources)
      // An uploaded sheet has no words behind it at all - nobody wrote a prompt
      // that produced it - so the description is read off it immediately rather
      // than left describing whatever was there before. Offered, not written.
      await describeFromSheet(p, up.image_path, true)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setRendering(null)
    }
  }

  /**
   * Rewrite a prop's words from its own sheet.
   *
   * Once a sheet exists it is the authority - it is the picture handed to the
   * renderer as a tagged reference, so the description should match THAT rather
   * than the guess that produced it. A sheet uploaded from outside has no words
   * behind it at all.
   *
   * Proposed, never written straight in: the description is already driving
   * every prompt that names this prop, so it is shown for approval first.
   */
  async function describeFromSheet(p: Prop, path?: string, write = false) {
    const flowId = import.meta.env.VITE_PANO_PROMPT_ID
    if (!flowId) {
      setError('VITE_PANO_PROMPT_ID is not set in .env.')
      return
    }
    // The caller passes the NEW path when a sheet has just changed: `p` is the
    // row as it was before the change, so reading p.image_path there would
    // describe the picture that was just replaced.
    const sheet = path ?? p.image_path
    if (!sheet) {
      setError(`${p.name} has no sheet to read.`)
      return
    }
    setRendering(p.id)
    setError(null)
    try {
      const res = parseFlowJson<{ action: string; description?: string; scale_note?: string; error?: string }>(
        await triggerFlow(flowId, { mode: 'prop', name: p.name, imagePath: sheet })
      )
      if (!res.ok || res.data.action !== 'described') {
        setError(`${p.name}: ${res.ok ? (res.data.error ?? res.data.action) : res.message}`)
        return
      }
      const description = res.data.description ?? ''
      const scale_note = res.data.scale_note ?? ''
      if (write) {
        // The sheet changed, so the words that described the old one are simply
        // wrong now - leaving them as a suggestion means the prompts keep using
        // a description of a picture nobody can see any more. Written, and both
        // fields are editable on the card if the reading is off.
        await patch(p, { description: description || null, scale_note: scale_note || null })
        setNote(`Description re-read from the new sheet for ${p.name}. Edit it below if it is off.`)
        return
      }
      setRead({ id: p.id, name: p.name, description, scale_note })
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setRendering(null)
    }
  }

  async function remove(p: Prop) {
    setBusy(true)
    const { error: e } = await insforge.database.from('movie_props').delete().eq('id', p.id)
    setBusy(false)
    if (e) setError(e.message)
    await load()
  }

  async function patch(p: Prop, change: Partial<Prop>) {
    const { error: e } = await insforge.database.from('movie_props').update(change).eq('id', p.id)
    if (e) setError(e.message)
    await load()
  }

  /**
   * Render the prop's sheet.
   *
   * The scale note is what makes this worth doing: "a glowing crystal" says
   * nothing about how big it is, so the prompt puts it next to something of
   * known size rather than floating alone.
   */
  async function renderSheet(p: Prop) {
    const flowId = import.meta.env.VITE_IMAGE_EDIT_ID
    if (!flowId) {
      setError('VITE_IMAGE_EDIT_ID is not set in .env.')
      return
    }
    setRendering(p.id)
    setError(null)
    const scale = p.scale_note?.trim()
    const prompt = [
      // The movie's look first, exactly as the Director prefixes a frame prompt.
      STYLES[p.render_style ?? style].prefix,
      // A turnaround, not one picture of the object sitting somewhere. Several
      // views of the SAME object is what makes a sheet usable as a reference:
      // one angle leaves the other sides to be invented, which is how the same
      // prop comes back different from a new angle.
      `Product reference sheet of one ${p.kind === 'wardrobe' ? 'costume' : 'prop'}: ${p.name}.`,
      p.description?.trim() ? `${p.description.trim()}.` : '',
      p.kind === 'wardrobe'
        ? 'Three views of the same costume laid out on one sheet: a large front view above, a back view and a side view below.'
        : 'Three views of the same object laid out on one sheet: a large side view above, a front view and a rear view below.',
      // Stated, never shown. The hand that used to be in here for scale was a
      // mistake: this sheet is registered as a tagged picture reference at
      // render time, so anything in it can bleed into the film - and a stray
      // hand is exactly the kind of thing that does.
      scale ? `The object is ${scale}; keep every view in correct proportion.` : '',
      'Plain white background, even studio lighting, no shadow, every view fully visible and uncropped.',
      'No people, no hands, no scenery, no text, no measurements, no logo, no watermark.'
    ]
      .filter(Boolean)
      .join(' ')
    try {
      const res = parseFlowJson<{ outputPath: string }>(
        await triggerFlow(flowId, { movieId: movie.id, prompt, references: [], width: SHEET_W, height: SHEET_H, steps: 8 })
      )
      if (!res.ok) {
        setError(`${p.name}: ${res.message}`)
        return
      }
      await patch(p, { image_path: res.data.outputPath })
      // A rendered sheet came FROM the description, so re-reading it usually
      // agrees - but not always, and where it disagrees the picture is what the
      // renderer will actually reference.
      await describeFromSheet(p, res.data.outputPath, true)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setRendering(null)
    }
  }

  const pickerGroups = toPickerGroups(sources)
  const listed = (k: 'prop' | 'wardrobe') => props.filter((p) => p.kind === k)

  return (
    <div>
      <p>
        Props and wardrobe for {movie.title} - the things that are neither characters nor locations. The
        cast hold still because they have reference sheets; a prop has nothing, so every render invents it
        again. Give each one a sheet and the Director can hold it steady the way it holds a face steady.
      </p>

      {/* Reading them out of the script beats typing them in, and it catches
          the alternate names - one Starfall draft called the same object "a
          wish star crystal", "the crystal", "the cracked crystal" and "wish
          star", and a prop matched on its one canonical name binds to almost
          none of those lines. */}
      <h4>From the script</h4>
      <p className="empty">
        Reads this movie's beats and proposes the props and costumes the story actually needs, with
        their size and the other words the script calls them by. Review before anything is saved.
      </p>
      <button type="button" disabled={busy || rendering !== null} onClick={findInScript}>
        {busy && !found ? 'Reading the script…' : 'Find props in the script'}
      </button>

      {found && (
        <div className="clip-grid">
          {found.map((p, i) => (
            <div className="beat-card" key={`${p.name}-${i}`}>
              <p>
                <strong>{p.name}</strong> <span className="badge">{p.kind}</span>
              </p>
              <label className="field-stack">
                Looks like
                <input
                  value={p.description}
                  onChange={(e) =>
                    setFound(found.map((x, j) => (j === i ? { ...x, description: e.target.value } : x)))
                  }
                />
              </label>
              {/* On its own line because it is the field that decides whether a
                  prop holds still: "a glowing crystal" says nothing about size,
                  so the same object comes out different in every shot. */}
              <label className="field-stack" title="Size has to be stated - a description alone never fixes it">
                Scale
                <input
                  value={p.scale_note}
                  placeholder="fits in a cupped hand"
                  onChange={(e) =>
                    setFound(found.map((x, j) => (j === i ? { ...x, scale_note: e.target.value } : x)))
                  }
                />
              </label>
              <label className="field-stack">
                Also called
                <input
                  value={(p.aliases ?? []).join(', ')}
                  onChange={(e) =>
                    setFound(
                      found.map((x, j) =>
                        j === i
                          ? { ...x, aliases: e.target.value.split(',').map((a) => a.trim()).filter(Boolean) }
                          : x
                      )
                    )
                  }
                />
              </label>
              <button type="button" onClick={() => setFound(found.filter((_, j) => j !== i))}>
                Drop
              </button>
            </div>
          ))}
        </div>
      )}
      {found && (
        <div className="upload-form">
          <button type="button" disabled={busy} onClick={saveFound}>
            {busy ? 'Saving…' : `Save props and wardrobe (${found.length})`}
          </button>
          <button type="button" disabled={busy} onClick={() => setFound(null)}>
            Discard
          </button>
        </div>
      )}

      <h4>Add one</h4>
      <div className="upload-form">
        <label className="field-stack">
          Name (as the script says it)
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="the wish star" />
        </label>
        <label className="field-stack">
          Kind
          <Select
            value={kind}
            onValueChange={(v) => setKind(v as 'prop' | 'wardrobe')}
            items={[
              { value: 'prop', label: 'Prop' },
              { value: 'wardrobe', label: 'Wardrobe' }
            ]}
          />
        </label>
        <label className="field-stack">
          Description
          <input
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="a glowing pale-blue crystal shard"
          />
        </label>
        <label className="field-stack" title="Size has to be stated - a description alone never fixes it">
          Scale
          <input
            value={scaleNote}
            onChange={(e) => setScaleNote(e.target.value)}
            placeholder="fits in a cupped hand"
          />
        </label>
        <button type="button" disabled={busy} onClick={addProp}>
          Add
        </button>
        <label className="field-stack" title="The look every sheet is rendered in. Taken from the cast's render style; change it if a prop should differ.">
          Style
          <Select
            value={style}
            onValueChange={(v) => setStyle(v as StyleKey)}
            items={(Object.keys(STYLES) as StyleKey[]).map((k) => ({ value: k, label: STYLES[k].label }))}
          />
        </label>
      </div>
      {error && <p className="error">{error}</p>}
      {note && <p className="run-status-ok">{note}</p>}

      {(['prop', 'wardrobe'] as const).map((k) => (
        <div key={k}>
          <h4>{k === 'prop' ? 'Props' : 'Wardrobe'}</h4>
          {listed(k).length === 0 && <p className="empty">Nothing yet.</p>}
          <div className="clip-grid">
            {listed(k).map((p) => (
              <div className="beat-card" key={p.id}>
                <p>
                  <strong>{p.name}</strong>
                </p>
                {p.image_path ? (
                  <img className="shot-preview" src={comfyViewUrl(p.image_path)} alt={p.name} />
                ) : (
                  <p className="empty">No sheet yet - every render will invent this one.</p>
                )}
                {/* Editable in place. They were read-only, which was fine while
                    a human typed them once - but a new sheet now rewrites them
                    from the picture, and a reading that is slightly off needs
                    correcting here rather than by re-uploading. */}
                <label className="field-stack">
                  Looks like
                  <input
                    key={`d-${p.id}-${p.description ?? ''}`}
                    defaultValue={p.description ?? ''}
                    placeholder="shape, colour, material, condition"
                    disabled={busy || rendering !== null}
                    onBlur={(e) => {
                      const v = e.target.value.trim() || null
                      if (v !== (p.description ?? null)) patch(p, { description: v })
                    }}
                  />
                </label>
                <label className="field-stack" title="Size has to be stated - a description alone never fixes it">
                  Scale
                  <input
                    key={`s-${p.id}-${p.scale_note ?? ''}`}
                    defaultValue={p.scale_note ?? ''}
                    placeholder="fits in a cupped hand"
                    disabled={busy || rendering !== null}
                    onBlur={(e) => {
                      const v = e.target.value.trim() || null
                      if (v !== (p.scale_note ?? null)) patch(p, { scale_note: v })
                    }}
                  />
                </label>
                {/* Without these a prop matches almost nothing: one draft called
                    the same object "a wish star crystal", "the crystal", "the
                    cracked crystal" and "wish star". Comma separated; the
                    longest phrase wins so the fullest one gets described. */}
                <label className="field-stack">
                  Also called (comma separated)
                  <input
                    defaultValue={(p.aliases ?? []).join(', ')}
                    placeholder="crystal, wish star crystal"
                    disabled={busy || rendering !== null}
                    onBlur={(e) => {
                      const next = e.target.value
                        .split(',')
                        .map((x) => x.trim())
                        .filter(Boolean)
                      if (JSON.stringify(next) !== JSON.stringify(p.aliases ?? [])) patch(p, { aliases: next })
                    }}
                  />
                </label>
                {/* Per prop, like a character's. Most take the film's look, but
                    one occasionally should not - a photograph of a real car
                    inside an animated film holds it better than a drawing. */}
                {p.kind === 'wardrobe' && (
                  <label className="field-stack" title="A costume binds to whoever wears it, because the shot names the person, not the clothes">
                    Worn by
                    <Select
                      value={p.worn_by ?? ''}
                      onValueChange={(v) => patch(p, { worn_by: v || null })}
                      items={[{ value: '', label: 'nobody in particular' }, ...cast.map((c) => ({ value: c, label: c }))]}
                      disabled={busy || rendering !== null}
                    />
                  </label>
                )}
                <label className="field-stack">
                  Drawn as
                  <Select
                    value={p.render_style ?? 'photographic'}
                    onValueChange={(v) => patch(p, { render_style: v as StyleKey })}
                    items={(Object.keys(STYLES) as StyleKey[]).map((k) => ({ value: k, label: STYLES[k].label }))}
                    disabled={rendering !== null || busy}
                  />
                </label>
                <button type="button" disabled={rendering !== null || busy} onClick={() => renderSheet(p)}>
                  {rendering === p.id ? 'Rendering…' : p.image_path ? 'Redo sheet' : 'Render sheet'}
                </button>
                {/* The sheet is the authority once it exists - it is the picture
                    the renderer references - so the words should describe it.
                    Especially for an uploaded photo, which has no words behind
                    it at all. */}
                {p.image_path && (
                  <button
                    type="button"
                    disabled={rendering !== null || busy}
                    onClick={() => describeFromSheet(p)}
                  >
                    {rendering === p.id ? 'Reading…' : 'Describe from the sheet'}
                  </button>
                )}
                {read && read.id === p.id && (
                  <div className="beat-card">
                    <p className="empty">Read off the sheet. Check it, then keep it.</p>
                    <label className="field-stack">
                      Looks like
                      <input
                        value={read.description}
                        onChange={(e) => setRead({ ...read, description: e.target.value })}
                      />
                    </label>
                    <label className="field-stack">
                      Scale
                      <input
                        value={read.scale_note}
                        onChange={(e) => setRead({ ...read, scale_note: e.target.value })}
                      />
                    </label>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={async () => {
                        await patch(p, {
                          description: read.description.trim() || null,
                          scale_note: read.scale_note.trim() || null
                        })
                        setRead(null)
                      }}
                    >
                      Keep it
                    </button>
                    <button type="button" onClick={() => setRead(null)}>
                      Discard
                    </button>
                  </div>
                )}
                {/* Or use a picture you already have - a frame from a clip, an
                    edit, anything the pickers can see. One write, no render. */}
                <ImageSelect
                  value=""
                  onValueChange={async (id) => {
                    const src = sources.find((x) => x.id === id)
                    if (!src) return
                    await patch(p, { image_path: src.path })
                    // The words described the old picture. Read the new one and
                    // offer it - still for approval, never written straight in.
                    await describeFromSheet(p, src.path, true)
                  }}
                  groups={pickerGroups}
                  placeholder="Use an existing picture…"
                  disabled={rendering !== null || busy}
                  resetAfterPick
                />
                {/* Or a picture from your own machine - a photo of the real
                    object, a still off the internet, a sheet drawn elsewhere.
                    It goes into the movie's own ComfyUI folder rather than
                    InsForge storage, because every image picker in the app
                    builds its list from ComfyUI paths and a storage key could
                    never appear in one. */}
                <label className="field-stack">
                  Upload a picture
                  <input
                    type="file"
                    accept="image/png,image/jpeg,image/webp"
                    disabled={rendering !== null || busy}
                    onChange={(e) => {
                      const file = e.target.files?.[0]
                      // Cleared either way, so the same file can be picked twice.
                      e.target.value = ''
                      if (file) uploadSheet(p, file)
                    }}
                  />
                </label>
                <button type="button" disabled={busy} onClick={() => remove(p)}>
                  Delete
                </button>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}
