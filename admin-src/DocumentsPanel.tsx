import { useEffect, useState } from 'react'
import { Select } from './ui/Select'
import { insforge, type Movie, type DocumentRow, type Character } from './insforge'

const KINDS = ['screenplay', 'character_bible', 'book', 'trailer_script', 'character_reference_image', 'other']
const CHARACTER_REFERENCE_IMAGE = 'character_reference_image'
// Same 5 values as character_images.kind - a manually uploaded reference
// image tagged with one of these can stand in for that specific kind at
// generation time instead of auto-generating it. Untagged (no shot_kind)
// reference images still work as a general vision-description source for
// Character-Bible-Generator, just don't replace a specific generated kind.
const SHOT_KINDS = ['turnaround', 'closeup', 'portrait', 'uppertorso', 'fbody']

function formatBytes(bytes: number | null) {
  if (bytes == null) return '—'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

export function DocumentsPanel({ movie }: { movie: Movie }) {
  const [documents, setDocuments] = useState<DocumentRow[]>([])
  const [characters, setCharacters] = useState<Character[]>([])
  const [loading, setLoading] = useState(true)
  const [kind, setKind] = useState(KINDS[0])
  const [characterId, setCharacterId] = useState('')
  const [shotKind, setShotKind] = useState('')
  const [file, setFile] = useState<File | null>(null)
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const [previewName, setPreviewName] = useState<string | null>(null)
  const [previewText, setPreviewText] = useState<string | null>(null)

  async function loadDocuments() {
    setLoading(true)
    const [docsRes, charsRes] = await Promise.all([
      insforge.database.from('documents').select('*').eq('movie_id', movie.id).order('created_at', { ascending: false }),
      insforge.database.from('characters').select('*').eq('movie_id', movie.id).order('name', { ascending: true })
    ])
    if (docsRes.error) setError(docsRes.error.message)
    else setDocuments((docsRes.data ?? []) as DocumentRow[])
    if (charsRes.error) setError(charsRes.error.message)
    else setCharacters((charsRes.data ?? []) as Character[])
    setLoading(false)
  }

  useEffect(() => {
    loadDocuments()
    setPreviewUrl(null)
    setPreviewName(null)
    setPreviewText(null)
    setKind(KINDS[0])
    setCharacterId('')
    setShotKind('')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [movie.id])

  async function handleUpload(e: React.FormEvent) {
    e.preventDefault()
    if (!file) return
    if (kind === CHARACTER_REFERENCE_IMAGE && !characterId) {
      setError('Select which character this reference image is for.')
      return
    }
    setUploading(true)
    setError(null)

    const key = `${kind}/${Date.now()}-${file.name}`
    const { data: uploadData, error: uploadError } = await insforge.storage
      .from(movie.bucket_name)
      .upload(key, file)

    if (uploadError || !uploadData) {
      setError(uploadError?.message ?? 'Upload failed')
      setUploading(false)
      return
    }

    const { error: insertError } = await insforge.database.from('documents').insert([
      {
        movie_id: movie.id,
        kind,
        character_id: kind === CHARACTER_REFERENCE_IMAGE ? characterId : null,
        shot_kind: kind === CHARACTER_REFERENCE_IMAGE && shotKind ? shotKind : null,
        original_filename: file.name,
        storage_key: uploadData.key,
        url: uploadData.url,
        mime_type: file.type || null,
        size_bytes: file.size
      }
    ])

    if (insertError) setError(insertError.message)
    setFile(null)
    setUploading(false)
    loadDocuments()
  }

  async function handleView(doc: DocumentRow) {
    setError(null)
    const { data: blob, error } = await insforge.storage
      .from(movie.bucket_name)
      .download(doc.storage_key)
    if (error || !blob) {
      setError(error?.message ?? 'Could not load file')
      return
    }
    setPreviewName(doc.original_filename)
    // Text files were being framed in an <iframe>, which the browser renders
    // with its own dark-mode UA styles (white text) against the frame's forced
    // white background - unreadable. Read them out and render as real text in
    // the app's own palette; only binary formats still need the frame.
    const isBinary = /\.(png|jpe?g|gif|webp|pdf)$/i.test(doc.original_filename)
    if (isBinary) {
      setPreviewText(null)
      setPreviewUrl(URL.createObjectURL(blob))
    } else {
      setPreviewUrl(null)
      setPreviewText(await blob.text())
    }
  }

  async function handleDelete(doc: DocumentRow) {
    if (!confirm(`Delete "${doc.original_filename}"? This removes it from storage too.`)) return
    setError(null)
    await insforge.storage.from(movie.bucket_name).remove(doc.storage_key)
    const { error } = await insforge.database.from('documents').delete().eq('id', doc.id)
    if (error) setError(error.message)
    loadDocuments()
  }

  return (
    <div>
      <form className="upload-form" onSubmit={handleUpload}>
        <Select
          value={kind}
          onValueChange={(v) => {
            setKind(v)
            setCharacterId('')
            setShotKind('')
          }}
          items={KINDS.map((k) => ({ value: k, label: k }))}
        />
        {kind === CHARACTER_REFERENCE_IMAGE && (
          <Select
            value={characterId}
            onValueChange={setCharacterId}
            placeholder={
              characters.length === 0 ? 'No characters yet — run Beat/Trigger first' : 'Select character…'
            }
            items={characters.map((c) => ({ value: c.id, label: c.name }))}
          />
        )}
        {kind === CHARACTER_REFERENCE_IMAGE && (
          <Select
            value={shotKind}
            onValueChange={setShotKind}
            placeholder="General reference (no specific shot)"
            items={SHOT_KINDS.map((sk) => ({ value: sk, label: sk }))}
          />
        )}
        <input
          type="file"
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
        />
        <button
          type="submit"
          disabled={!file || uploading || (kind === CHARACTER_REFERENCE_IMAGE && (characters.length === 0 || !characterId))}
        >
          {uploading ? 'Uploading…' : 'Upload'}
        </button>
      </form>

      {error && <p className="error">{error}</p>}

      {loading ? (
        <p>Loading documents…</p>
      ) : documents.length === 0 ? (
        <p className="empty">No documents uploaded for {movie.title} yet.</p>
      ) : (
        <table className="data-table">
          <thead>
            <tr>
              <th>Kind</th>
              <th>Character</th>
              <th>Filename</th>
              <th>Size</th>
              <th>Uploaded</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {documents.map((doc) => (
              <tr key={doc.id}>
                <td>
                  <span className="badge">{doc.kind}</span>
                </td>
                <td>
                  {doc.character_id ? characters.find((c) => c.id === doc.character_id)?.name ?? '—' : '—'}
                  {doc.shot_kind && <span className="badge">{doc.shot_kind}</span>}
                </td>
                <td>{doc.original_filename}</td>
                <td>{formatBytes(doc.size_bytes)}</td>
                <td>{new Date(doc.created_at).toLocaleString()}</td>
                <td className="actions">
                  <button onClick={() => handleView(doc)}>View</button>
                  <button className="danger" onClick={() => handleDelete(doc)}>
                    Delete
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {(previewUrl || previewText !== null) && (
        <div className="preview">
          <div className="preview-header">
            <strong>{previewName}</strong>
            <button
              onClick={() => {
                setPreviewUrl(null)
                setPreviewText(null)
              }}
            >
              Close
            </button>
          </div>
          {previewName?.match(/\.(png|jpe?g|gif|webp)$/i) ? (
            <img src={previewUrl ?? undefined} alt={previewName ?? ''} />
          ) : previewText !== null ? (
            <pre className="preview-text">{previewText}</pre>
          ) : (
            <iframe title="document preview" src={previewUrl ?? undefined} />
          )}
        </div>
      )}
    </div>
  )
}
