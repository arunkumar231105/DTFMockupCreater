// ── Save a file to the vault from inside a task ─────────────────────────────
// The same upload the Vault's "Upload Artwork" does — file type (REF / SRC / WRK /
// FNL / FNLA), and for WRK/FNL/FNLA the design it belongs to, so the file inherits
// that design's AW-<CLIENT>-<NNNN> code and only its suffix changes.
//
// What the task already knows fills the rest in: its design code (the task's
// entity, e.g. AW-TVU01-0002) finds the customer in the vault and pre-selects that
// design. The file goes to the customer's Nextcloud folder, named to the
// standard, and is added to this task's Artwork tab — the vault holds the file,
// the task keeps a pointer, exactly as attaching from the Vault does.
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { detectApiBase } from '../utils/apiConfig';
import { taskApi } from '../utils/taskApi';
import { toTaskArtworks } from '../utils/vaultArtwork';
import './Vault.css';

const TYPES = [
  { code: 'REF', label: 'Reference', tone: 'src' },
  { code: 'SRC', label: 'Source (Original)', tone: 'src' },
  { code: 'WRK', label: 'Working File', tone: 'wrk' },
  { code: 'FNL', label: 'Final', tone: 'fnl' },
  { code: 'FNLA', label: 'Approved (Final)', tone: 'fnla' },
];
const ATTACH_TYPES = new Set(['WRK', 'FNL', 'FNLA']);
const TONE = { REF: 'src', SRC: 'src', WRK: 'wrk', FNL: 'fnl', FNLA: 'fnla', MU: 'mu', GS: 'gs', OUT: 'out' };
const CODE_RE = /AW-[A-Z0-9]+-\d{3,6}/i;
const sizeOf = (b) => (b > 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`);

// The design this task is about: its entity id when that is a design code, else
// the first attached artwork's code.
function designCodeOf(task) {
  const fromEntity = CODE_RE.exec(String(task?.entityId || ''))?.[0];
  if (fromEntity) return fromEntity.toUpperCase();
  for (const a of task?.artworks || []) {
    const c = a.artworkCode || CODE_RE.exec(String(a.fileName || ''))?.[0];
    if (c) return String(c).toUpperCase();
  }
  return '';
}

// nginx answers an oversized upload with an HTML page, not JSON — read first, then explain.
async function readError(res, file) {
  const raw = await res.text().catch(() => '');
  try {
    const data = JSON.parse(raw);
    const said = data.message || data.detail || data.error;
    if (said) return said;
  } catch { /* not JSON */ }
  if (res.status === 413) return `too large (${(file.size / 1048576).toFixed(1)} MB) — the upload limit is 100 MB`;
  if ([502, 503, 504].includes(res.status)) return 'the artwork service is not answering right now — try again in a minute';
  return `upload failed (${res.status})`;
}

export default function TaskVaultUpload({ task, onChanged }) {
  const [apiBase, setApiBase] = useState(null);
  const [customer, setCustomer] = useState({ loading: true, key: '', name: '', error: '' });
  const [type, setType] = useState('WRK');
  const [pieces, setPieces] = useState([]);
  const [piecesLoading, setPiecesLoading] = useState(false);
  const [pieceSearch, setPieceSearch] = useState('');
  const [attachTo, setAttachTo] = useState('');
  const [files, setFiles] = useState([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState(null);
  const inputRef = useRef(null);

  const code = designCodeOf(task);
  const needsAttach = ATTACH_TYPES.has(type);
  const firstArtworkName = task?.artworks?.[0]?.fileName || '';

  useEffect(() => { detectApiBase().then(setApiBase).catch(() => setApiBase('/api')); }, []);

  // Find the customer in the vault from the task's design code.
  useEffect(() => {
    if (!apiBase) return undefined;
    const needle = code || firstArtworkName;
    if (!needle) {
      setCustomer({ loading: false, key: '', name: '', error: 'This task has no vault design — upload from the Vault instead.' });
      return undefined;
    }
    let active = true;
    setCustomer((c) => ({ ...c, loading: true, error: '' }));
    const params = new URLSearchParams({ search: needle, page: '1', limit: '12' });
    fetch(`${apiBase}/central-artwork.php?action=vault&${params}`, { cache: 'no-store' })
      .then((r) => r.json())
      .then((payload) => {
        if (!active) return;
        const rows = payload?.data?.rows || [];
        const hit = rows.find((r) => code && String(r.artwork_code || '').toUpperCase() === code) || rows[0];
        if (hit?.entity_key) setCustomer({ loading: false, key: hit.entity_key, name: hit.entity_name || hit.folder || '', error: '' });
        else setCustomer({ loading: false, key: '', name: '', error: `No vault file was found for ${needle}.` });
      })
      .catch(() => { if (active) setCustomer({ loading: false, key: '', name: '', error: 'The vault could not be reached.' }); });
    return () => { active = false; };
  }, [apiBase, code, firstArtworkName]);

  // The customer's designs, with this task's design chosen when it is there.
  useEffect(() => {
    if (!apiBase || !customer.key || !needsAttach) { setPieces([]); return undefined; }
    let active = true;
    setPiecesLoading(true);
    fetch(`${apiBase}/central-artwork.php?action=pieces&entity_key=${encodeURIComponent(customer.key)}`, { cache: 'no-store' })
      .then((r) => r.json())
      .then((payload) => {
        if (!active) return;
        const rows = payload?.data?.rows || [];
        setPieces(rows);
        setAttachTo((current) => (current && rows.some((p) => p.id === current)
          ? current
          : (rows.find((p) => String(p.artwork_code || '').toUpperCase() === code)?.id || '')));
      })
      .catch(() => { if (active) setPieces([]); })
      .finally(() => { if (active) setPiecesLoading(false); });
    return () => { active = false; };
  }, [apiBase, customer.key, needsAttach, code]);

  const attached = pieces.find((p) => p.id === attachTo) || null;
  const matching = useMemo(() => {
    const needle = pieceSearch.trim().toLowerCase();
    return needle ? pieces.filter((p) => `${p.artwork_code} ${p.file_name}`.toLowerCase().includes(needle)) : pieces;
  }, [pieces, pieceSearch]);

  const plannedName = useMemo(() => {
    const ext = (files[0]?.name.split('.').pop() || 'png').toLowerCase();
    if (needsAttach) return attached ? `${attached.artwork_code}-${type}.${ext}` : null;
    return `AW-<code>-<next number>-${type}.${ext}`;
  }, [needsAttach, attached, type, files]);

  const addFiles = (list) => {
    const incoming = Array.from(list || []);
    if (incoming.length) { setFiles((prev) => [...prev, ...incoming]); setMessage(null); }
  };

  const upload = async () => {
    if (!files.length || !apiBase || !customer.key) return;
    if (needsAttach && !attachTo) { setMessage({ ok: false, text: 'Pick the design this file belongs to.' }); return; }
    setBusy(true);
    setMessage(null);
    const saved = [];
    const failures = [];
    for (const file of files) {
      try {
        const form = new FormData();
        form.append('file', file);
        form.append('entity_key', customer.key);
        form.append('lifecycle_code', type);
        if (needsAttach) form.append('attach_to', attachTo);
        const res = await fetch(`${apiBase}/central-artwork.php?action=upload`, { method: 'POST', body: form });
        if (!res.ok) throw new Error(await readError(res, file));
        const payload = await res.json().catch(() => ({}));
        const d = payload?.data || payload || {};
        const fileName = d.file_name || file.name;
        saved.push({
          id: d.asset_id, file_name: fileName, folder: d.folder,
          artwork_code: attached?.artwork_code || CODE_RE.exec(fileName)?.[0] || undefined,
          entity_name: customer.name || undefined, mime_type: file.type || undefined, file_size_bytes: file.size,
        });
      } catch (err) {
        failures.push(`${file.name}: ${err.message || 'failed'}`);
      }
    }

    // The vault holds the file; the task keeps a pointer to it in its Artwork tab.
    const linkable = saved.filter((s) => s.id);
    if (linkable.length) {
      try {
        const artworks = await toTaskArtworks(linkable, apiBase);
        await taskApi.addArtworks(task.id, artworks);
      } catch (err) {
        failures.push(`saved to the vault, but not added to the task: ${err.message || 'failed'}`);
      }
    }

    if (failures.length) {
      setMessage({ ok: false, text: `${saved.length} saved, ${failures.length} problem${failures.length === 1 ? '' : 's'} — ${failures[0]}` });
    } else {
      const names = saved.map((s) => s.file_name).join(', ');
      setMessage({ ok: true, text: `Saved to the vault as ${names} and added to this task's Artwork.` });
      setFiles([]);
    }
    setBusy(false);
    onChanged?.();
  };

  return (
    <div className="tm-vault-upload">
      <div className="tm-vault-upload-title">Save a file to the vault</div>
      <p className="tm-muted tm-vault-upload-sub">
        Named to the standard in the customer&apos;s Nextcloud folder, then added to this task&apos;s Artwork.
      </p>

      <div className="vault-upload-context">
        <div className="vault-upload-field">
          <label>Customer</label>
          <span className={customer.key ? 'has-value' : 'no-value'}>
            {customer.loading ? 'Finding the customer…' : customer.key ? (customer.name || customer.key) : customer.error}
          </span>
        </div>
        <div className="vault-upload-field">
          <label>Task design</label>
          <span className={code ? 'has-value' : 'no-value'}>{code || '—'}</span>
        </div>
      </div>

      <div className="vault-upload-field">
        <label>File Type</label>
        <div className="vault-upload-lifecycle-grid">
          {TYPES.map((t) => (
            <button key={t.code} type="button" className={`vault-upload-lc-btn ${type === t.code ? 'active' : ''}`} onClick={() => setType(t.code)}>
              <span className={`vault-life vault-life-${t.tone}`}>{t.code}</span>
              <span>{t.label}</span>
            </button>
          ))}
        </div>
      </div>

      {needsAttach && (
        <div className="vault-upload-field">
          <label>
            Which design is this {TYPES.find((t) => t.code === type)?.label.toLowerCase()} for?
            <span className="vault-upload-required"> required</span>
          </label>
          {!customer.key ? (
            <div className="vault-attach-empty">{customer.loading ? 'Finding the customer…' : 'No customer found for this task.'}</div>
          ) : piecesLoading ? (
            <div className="vault-attach-empty">Loading designs…</div>
          ) : !pieces.length ? (
            <div className="vault-attach-empty">This customer has no coded design yet — save its source (SRC) first.</div>
          ) : (
            <>
              <input className="vault-picker-search vault-attach-search" placeholder={`Search ${pieces.length} designs…`}
                value={pieceSearch} onChange={(e) => setPieceSearch(e.target.value)} />
              <div className="vault-attach-list">
                {matching.map((piece) => (
                  <button key={piece.id} type="button" className={`vault-attach-row ${attachTo === piece.id ? 'active' : ''}`} onClick={() => setAttachTo(piece.id)}>
                    <img className="vault-attach-thumb" alt="" loading="lazy"
                      src={`${apiBase}/central-artwork.php?action=thumb&id=${encodeURIComponent(piece.id)}&w=80&h=80&v=${encodeURIComponent(piece.preview_key || '')}`}
                      onError={(e) => { e.currentTarget.style.visibility = 'hidden'; }} />
                    <span className="vault-attach-info">
                      <span className="vault-attach-code">
                        {piece.artwork_code}
                        {String(piece.artwork_code || '').toUpperCase() === code && <em className="tm-vault-this"> · this task</em>}
                      </span>
                      <span className="vault-attach-file">{piece.file_name}</span>
                    </span>
                    {piece.lifecycle_code && <span className={`vault-life vault-life-${TONE[piece.lifecycle_code] || 'src'}`}>{piece.lifecycle_code}</span>}
                  </button>
                ))}
                {!matching.length && <div className="vault-attach-empty">No design matches “{pieceSearch}”</div>}
              </div>
            </>
          )}
        </div>
      )}

      <div
        className={`vault-upload-dropzone ${files.length ? 'has-file' : ''}`}
        onClick={() => inputRef.current?.click()}
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => { e.preventDefault(); addFiles(e.dataTransfer.files); }}
      >
        {files.length ? (
          <div className="vault-upload-list" onClick={(e) => e.stopPropagation()}>
            {files.map((file, i) => (
              <div className="vault-upload-list-row" key={`${file.name}-${i}`}>
                <span className="vault-upload-file-icon">📄</span>
                <span className="vault-upload-list-name" title={file.name}>{file.name}</span>
                <span className="vault-upload-size">{sizeOf(file.size)}</span>
                <button type="button" className="vault-upload-list-remove" onClick={() => setFiles((prev) => prev.filter((_, n) => n !== i))}>×</button>
              </div>
            ))}
            <div className="vault-upload-list-add" onClick={() => inputRef.current?.click()}>+ Add more files</div>
          </div>
        ) : (
          <div className="vault-upload-placeholder">
            <span className="vault-upload-icon">↑</span>
            <span>Drop files here or click to browse</span>
            <span className="vault-upload-hint">PNG, JPG, PDF, AI, PSD — one or many at once</span>
          </div>
        )}
        <input ref={inputRef} type="file" multiple style={{ display: 'none' }}
          accept="image/*,application/pdf,.ai,.psd,.eps,.svg"
          onChange={(e) => { addFiles(e.target.files); e.target.value = ''; }} />
      </div>

      <div className="tm-vault-upload-foot">
        <span className="tm-muted">
          {plannedName ? <>Will be saved as <b>{plannedName}</b></> : needsAttach ? 'Pick the design to see the file name' : ''}
        </span>
        <button type="button" className="tm-btn tm-btn-primary"
          disabled={busy || !files.length || !customer.key || (needsAttach && !attachTo)} onClick={upload}>
          {busy ? 'Saving…' : `↑ Save to vault${files.length > 1 ? ` (${files.length})` : ''}`}
        </button>
      </div>
      {message && <p className={message.ok ? 'tm-vault-ok' : 'tm-vault-err'}>{message.text}</p>}
    </div>
  );
}
