import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { detectApiBase } from '../utils/apiConfig';
import './Vault.css';

// ── Artwork Vault ────────────────────────────────────────────────────────────
// The same central vault PrintShop shows, read straight from Nextcloud's index
// so a designer never has to move a file between the two apps. Pick a customer,
// pick a folder, open the file in whichever studio tool the job needs; saving
// writes a WRK file back into that customer's Artworks folder in Nextcloud.
//
// Freshness comes from a change cursor, not from refetching the list: the vault
// holds ~5 800 files, so the grid asks "has anything changed?" (a ~120 byte
// answer) every few seconds and only reloads a page when the answer moves.

const REVISION_POLL_MS = 3000;
const PAGE_SIZE = 60;
// Designer apni pasand ki view chunta hai aur wahi agli baar bhi mile.
const VIEW_KEY = 'dsVaultView';

// Panel me tasveer badi chahiye, thumbnail nahi. Server hi resize karke deta hai,
// isliye 60 MB ki PSD ka asal file browser tak aata hi nahi. Naap tay hai taaki
// har file ke liye ek hi cached copy bane.
const PREVIEW_W = 1400;
const PREVIEW_H = 1400;

// Where a selected file can be sent. These mirror the studio's own pages.
const TARGETS = [
  { page: 'bgremover', label: 'Artwork Editor', primary: true },
  { page: 'mockupv2', label: 'Mockup' },
  { page: 'gangsheet', label: 'Gang Sheet' },
  { page: 'qa', label: 'QA Analysis' },
  { page: 'contrast', label: 'Contrast' },
];

// The upload type picks the Nextcloud sub-folder the file lands in:
//   REF / SRC → references   ·   WRK → Artworks   ·   FNL / FNLA → final_files
//
// A design keeps one identity — AW-<CLIENT>-<NNNN> — and only its type suffix
// changes as it moves SRC → WRK → FNL. So these downstream types must be told
// which design they belong to; they inherit its code instead of taking a new
// number. REF and SRC start a design, so they never ask.
const ATTACH_TYPES = new Set(['WRK', 'FNL', 'FNLA']);

const UPLOAD_LIFECYCLES = [
  { code: 'REF', label: 'Reference' },
  { code: 'SRC', label: 'Source (Original)' },
  { code: 'WRK', label: 'Working File' },
  { code: 'FNL', label: 'Final' },
  { code: 'FNLA', label: 'Approved (Final)' },
];

// The shop's published file naming standard — AW-<CLIENT>-<NNNN>-<TYPE>.<ext>.
const LIFECYCLE = {
  SRC: { label: 'Source', tone: 'src' },
  REF: { label: 'Reference', tone: 'src' },
  WRK: { label: 'Working', tone: 'wrk' },
  FNL: { label: 'Final', tone: 'fnl' },
  FNLA: { label: 'Approved', tone: 'fnla' },
  GS: { label: 'Gang Sheet', tone: 'gs' },
  MU: { label: 'Mockup', tone: 'mu' },
  MOCK: { label: 'Mockup', tone: 'mu' },
  OUT: { label: 'Sent', tone: 'out' },
};

const IMAGE_RE = /\.(png|jpe?g|webp|gif|bmp|tiff?|svg|avif)$/i;

// The Artwork Generator is a separate app on this host. It has no TLS name yet,
// so the address is plain http — worth giving it one, but nothing secret travels
// in this link: the id names a row in PrintShop's index, and PrintShop will not
// act on that id without a signed token the generator mints server-side.
const GENERATOR_URL = 'http://31.97.110.197:4400';

// What the generator will actually accept as input.
const GENERATOR_RE = /\.(png|jpe?g|webp)$/i;

function isPreviewable(asset) {
  return /^image\//i.test(asset.mime_type || '') || IMAGE_RE.test(asset.file_name || '');
}

function fileSize(bytes) {
  if (!bytes) return '—';
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function formatDate(value) {
  if (!value) return '—';
  return new Date(value).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('File could not be read'));
    reader.readAsDataURL(blob);
  });
}

// A searchable picker — 400+ customers is far too many for a row of tabs.
function CustomerPicker({ customers, value, onChange }) {
  const [open, setOpen] = useState(false);
  const [term, setTerm] = useState('');
  const boxRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const close = (event) => { if (boxRef.current && !boxRef.current.contains(event.target)) setOpen(false); };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);

  const selected = customers.find(c => c.key === value);
  // The list is already scoped to the selected source by the server, so every
  // entry here is reachable — it is never truncated.
  const matches = useMemo(() => {
    const needle = term.trim().toLowerCase();
    if (!needle) return customers;
    return customers.filter(c => (c.name || '').toLowerCase().includes(needle) || (c.reference || '').toLowerCase().includes(needle));
  }, [customers, term]);

  return (
    <div className="vault-picker" ref={boxRef}>
      <button type="button" className={`vault-picker-btn ${value ? 'is-set' : ''}`} onClick={() => { setOpen(o => !o); setTerm(''); }}>
        <span className="vault-picker-label">Customer</span>
        <span className="vault-picker-value">{selected ? selected.name : 'All customers'}</span>
        <span className="vault-picker-caret">▾</span>
      </button>
      {open && (
        <div className="vault-picker-panel">
          <input
            className="vault-picker-search"
            autoFocus
            placeholder={`Search ${customers.length} customers…`}
            value={term}
            onChange={(e) => setTerm(e.target.value)}
          />
          <ul className="vault-picker-list">
            <li>
              <button type="button" className={!value ? 'active' : ''} onClick={() => { onChange(''); setOpen(false); }}>
                All customers
              </button>
            </li>
            {matches.map(customer => (
              <li key={customer.key}>
                <button type="button" className={value === customer.key ? 'active' : ''} onClick={() => { onChange(customer.key); setOpen(false); }}>
                  <span className="vault-picker-name">{customer.name}</span>
                  {customer.reference && <span className="vault-picker-ref">{customer.reference}</span>}
                  <span className="vault-picker-count">{customer.files}</span>
                </button>
              </li>
            ))}
            {!matches.length && <li className="vault-picker-none">No customer matches “{term}”</li>}
          </ul>
        </div>
      )}
    </div>
  );
}

function VaultCard({ asset, apiBase, selected, onSelect }) {
  const [failed, setFailed] = useState(false);
  const life = LIFECYCLE[asset.lifecycle_code] || null;
  const previewable = isPreviewable(asset) && !failed;
  const src = `${apiBase}/central-artwork.php?action=thumb&id=${encodeURIComponent(asset.id)}&w=320&h=240&v=${encodeURIComponent(asset.preview_key || '')}`;

  return (
    <button type="button" className={`vault-card ${selected ? 'selected' : ''}`} onClick={() => onSelect(asset)}>
      <span className="vault-card-img">
        {previewable
          ? <img src={src} alt={asset.file_name} loading="lazy" decoding="async" onError={() => setFailed(true)} />
          : <span className="vault-card-ext">{(asset.file_name.split('.').pop() || 'FILE').toUpperCase()}</span>}
        {life && <span className={`vault-life vault-life-${life.tone}`}>{asset.lifecycle_code}</span>}
        {selected && <span className="vault-check">✓</span>}
      </span>
      <span className="vault-card-body">
        <span className="vault-card-name" title={asset.file_name}>{asset.file_name}</span>
        <span className="vault-card-meta">
          <span>{asset.folder}</span>
          <span>{fileSize(asset.file_size_bytes)}</span>
        </span>
      </span>
    </button>
  );
}

// Wahi file, ek line me. Card me tasveer bari dikhti hai; list me ek nazar me
// yeh dikhta hai ke file kis customer ki hai, kis folder me hai aur kab badli —
// jo card ki tang jagah me nahi aa sakta tha.
function VaultRow({ asset, apiBase, selected, onSelect }) {
  const [failed, setFailed] = useState(false);
  const life = LIFECYCLE[asset.lifecycle_code] || null;
  const previewable = isPreviewable(asset) && !failed;
  const src = `${apiBase}/central-artwork.php?action=thumb&id=${encodeURIComponent(asset.id)}&w=120&h=120&v=${encodeURIComponent(asset.preview_key || '')}`;

  return (
    <button type="button" className={`vault-row ${selected ? 'selected' : ''}`} onClick={() => onSelect(asset)}>
      <span className="vault-row-thumb">
        {previewable
          ? <img src={src} alt="" loading="lazy" decoding="async" onError={() => setFailed(true)} />
          : <span className="vault-row-ext">{(asset.file_name.split('.').pop() || 'FILE').toUpperCase()}</span>}
        {selected && <span className="vault-row-check">✓</span>}
      </span>
      <span className="vault-row-name">
        <strong title={asset.file_name}>{asset.file_name}</strong>
        {asset.artwork_code && <small>{asset.artwork_code}</small>}
      </span>
      <span className="vault-row-cell vault-row-entity">{asset.entity_name || 'Unlinked'}</span>
      <span className="vault-row-cell">{asset.folder || '—'}</span>
      <span className="vault-row-cell">
        {life
          ? <span className={`vault-life vault-life-${life.tone} is-inline`}>{asset.lifecycle_code}</span>
          : '—'}
      </span>
      <span className="vault-row-cell vault-row-num">{fileSize(asset.file_size_bytes)}</span>
      <span className="vault-row-cell vault-row-num">{formatDate(asset.source_modified_at)}</span>
    </button>
  );
}

// Panel ki badi tasveer. Jo file tasveer nahi hai (PSD, AI, PDF) uske liye
// khaali daba dikhane ka koi faida nahi — uski qisam saaf likh di jaati hai.
function PreviewStage({ asset, apiBase }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => { setFailed(false); }, [asset.id]);
  const previewable = isPreviewable(asset) && !failed;
  const src = `${apiBase}/central-artwork.php?action=thumb&id=${encodeURIComponent(asset.id)}&w=${PREVIEW_W}&h=${PREVIEW_H}&v=${encodeURIComponent(asset.preview_key || '')}`;
  if (!previewable) {
    return (
      <div className="vault-preview-stage is-file">
        <strong>{(asset.file_name.split('.').pop() || 'FILE').toUpperCase()}</strong>
        <span>No preview for this file type — open it in a studio tool below.</span>
      </div>
    );
  }
  return (
    <div className="vault-preview-stage">
      <img src={src} alt={asset.file_name} onError={() => setFailed(true)} />
    </div>
  );
}

function PreviewRow({ label, value }) {
  return <div className="vault-preview-row"><span>{label}</span><strong title={typeof value === 'string' ? value : undefined}>{value || '—'}</strong></div>;
}

function Vault({ onOpenAsset, onSendToTasks }) {
  const [apiBase, setApiBase] = useState(null);
  const [rows, setRows] = useState([]);
  const [total, setTotal] = useState(0);
  const [facets, setFacets] = useState({ roots: [], customers: [], folders: [], lifecycles: [] });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const [live, setLive] = useState(false);
  const [opening, setOpening] = useState('');

  const [root, setRoot] = useState('');
  const [customer, setCustomer] = useState('');
  const [folder, setFolder] = useState('');
  const [lifecycle, setLifecycle] = useState('');
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [page, setPage] = useState(1);
  // Cards ya list. Private window me localStorage rok deta hai, isliye har
  // padhne-likhne ko try me rakha hai — warna poora page hi nahi khulega.
  const [view, setView] = useState(() => {
    try { return localStorage.getItem(VIEW_KEY) === 'list' ? 'list' : 'cards'; } catch { return 'cards'; }
  });
  const chooseView = (next) => {
    setView(next);
    try { localStorage.setItem(VIEW_KEY, next); } catch { /* is baar ke liye phir bhi chalega */ }
  };
  // A studio tool opens one file, but a task is often a whole set — so the grid
  // keeps a selection and the action bar offers the tools only when it holds
  // exactly one file.
  const [selection, setSelection] = useState([]);
  const selected = selection.length === 1 ? selection[0] : null;
  const toggleSelected = (asset) =>
    setSelection(prev => (prev.some(a => a.id === asset.id) ? prev.filter(a => a.id !== asset.id) : [...prev, asset]));

  // Upload state
  const [showUpload, setShowUpload] = useState(false);
  // One or many files can be queued for a single customer + type.
  const [uploadFiles, setUploadFiles] = useState([]); // [{ file, preview }]
  const [uploadLifecycle, setUploadLifecycle] = useState('SRC');
  const [uploading, setUploading] = useState(false);
  const [uploadMessage, setUploadMessage] = useState('');
  const uploadInputRef = useRef(null);
  // "Which design is this?" — the source a WRK/FNL/FNLA upload attaches to.
  const [pieces, setPieces] = useState([]);
  const [piecesLoading, setPiecesLoading] = useState(false);
  const [attachTo, setAttachTo] = useState('');
  const [pieceSearch, setPieceSearch] = useState('');
  const needsAttach = ATTACH_TYPES.has(uploadLifecycle);
  const attachedPiece = pieces.find(p => p.id === attachTo) || null;

  // Escape se panel band — panel selection par khulta hai, isliye selection hi hatti hai.
  useEffect(() => {
    if (selection.length !== 1) return undefined;
    const onKey = (event) => { if (event.key === 'Escape') { setSelection([]); setStatus(''); } };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selection.length]);

  const revisionRef = useRef('');
  const inFlight = useRef(false);
  const pending = useRef(false);

  useEffect(() => { detectApiBase().then(setApiBase).catch(() => setApiBase('/api')); }, []);
  useEffect(() => {
    const timer = window.setTimeout(() => { setDebouncedSearch(search); setPage(1); }, 300);
    return () => window.clearTimeout(timer);
  }, [search]);

  const query = useMemo(() => {
    const params = new URLSearchParams();
    if (root) params.set('root', root);
    if (customer) params.set('entity_key', customer);
    if (folder) params.set('folder', folder);
    if (lifecycle) params.set('lifecycle', lifecycle);
    if (debouncedSearch.trim()) params.set('search', debouncedSearch.trim());
    return params;
  }, [root, customer, folder, lifecycle, debouncedSearch]);

  // Two things ask for a reload: a filter change and the live cursor. If one
  // arrives while the other is still fetching, remember it and run once more on
  // the way out — dropping it would leave the grid showing the wrong filter.
  const load = useCallback(async (showSpinner = false) => {
    if (!apiBase) return;
    if (inFlight.current) { pending.current = true; return; }
    inFlight.current = true;
    if (showSpinner) setLoading(true);
    try {
      const listParams = new URLSearchParams(query);
      listParams.set('page', String(page));
      listParams.set('limit', String(PAGE_SIZE));
      const [listRes, facetRes] = await Promise.all([
        fetch(`${apiBase}/central-artwork.php?action=vault&${listParams}`, { cache: 'no-store' }),
        fetch(`${apiBase}/central-artwork.php?action=facets&${query}`, { cache: 'no-store' }),
      ]);
      if (!listRes.ok) throw new Error(`Vault unavailable (${listRes.status})`);
      const listPayload = await listRes.json();
      const data = listPayload.data || {};
      // Hide "OUT" (Sent) files from the grid — these are finished files already
      // sent to production and just clutter the pre-order vault view.
      const allRows = data.rows || [];
      const visibleRows = allRows.filter(r => (r.lifecycle_code || '').toUpperCase() !== 'OUT');
      setRows(visibleRows);
      setTotal(data.total || 0);
      if (facetRes.ok) {
        const facetPayload = await facetRes.json();
        const next = facetPayload.data;
        if (next) setFacets({ roots: next.roots || [], customers: next.customers || [], folders: next.folders || [], lifecycles: next.lifecycles || [] });
      }
      setError('');
    } catch (err) {
      setError(err.message || 'The Artwork Vault could not be loaded.');
    } finally {
      inFlight.current = false;
      setLoading(false);
      if (pending.current) { pending.current = false; load(false); }
    }
  }, [apiBase, query, page]);

  useEffect(() => { load(true); }, [load]);

  // Change cursor. Deliberately unfiltered: a file that lands for another
  // customer still changes the folder counts on screen, so the whole view is
  // refreshed whenever anything in the vault moves.
  useEffect(() => {
    if (!apiBase) return undefined;
    let active = true;
    const tick = async () => {
      try {
        const res = await fetch(`${apiBase}/central-artwork.php?action=revision`, { cache: 'no-store' });
        if (!res.ok) throw new Error('offline');
        const payload = await res.json();
        const data = payload.data || {};
        if (!active) return;
        setLive(Boolean(data.watching));
        const stamp = `${data.revision}/${data.total}`;
        if (revisionRef.current && revisionRef.current !== stamp) load(false);
        revisionRef.current = stamp;
      } catch {
        if (active) setLive(false);
      }
    };
    tick();
    const timer = window.setInterval(tick, REVISION_POLL_MS);
    return () => { active = false; window.clearInterval(timer); };
  }, [apiBase, load]);

  // Fetch the selected file's bytes under a token scoped to that one asset, then
  // hand it to the requested studio tool. The token travels with it so the tool
  // can save the result straight back to Nextcloud.
  const openIn = async (target) => {
    if (!selected || !apiBase) return;
    setOpening(target.page);
    setStatus(`Opening ${selected.file_name} in ${target.label}…`);
    try {
      const handoffRes = await fetch(`${apiBase}/central-artwork.php?action=handoff&id=${encodeURIComponent(selected.id)}`);
      const handoff = await handoffRes.json();
      if (!handoffRes.ok || !handoff.data?.token) throw new Error(handoff.message || 'Could not check out this artwork');
      const contentRes = await fetch(`${apiBase}/central-artwork.php?action=content&token=${encodeURIComponent(handoff.data.token)}`);
      if (!contentRes.ok) throw new Error('Artwork content could not be downloaded');
      const dataUrl = await blobToDataUrl(await contentRes.blob());
      onOpenAsset(target.page, dataUrl, {
        ...selected,
        studio_token: handoff.data.token,
        file_name: handoff.data.file_name || selected.file_name,
      });
    } catch (err) {
      setError(err.message || 'This artwork could not be opened');
      setStatus('');
    } finally {
      setOpening('');
    }
  };

  const [trashing, setTrashing] = useState(false);

  // Move the whole selection to the Nextcloud Trash bin. The file leaves Leads
  // 2.0 and the vault at once, so it is a confirmed, deliberate action.
  const trashSelection = async () => {
    if (!apiBase || !selection.length || trashing) return;
    const count = selection.length;
    const ok = window.confirm(
      `Move ${count} file${count === 1 ? '' : 's'} to Trash?\n\n` +
      `They will be removed from the Vault and from Leads 2.0, and filed in ` +
      `Nextcloud under Trash/<customer>/<month>. This can be undone from Nextcloud.`
    );
    if (!ok) return;
    setTrashing(true);
    setStatus(`Moving ${count} file${count === 1 ? '' : 's'} to Trash…`);
    setError('');
    try {
      const res = await fetch(`${apiBase}/central-artwork.php?action=trash`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: selection.map(a => a.id) }),
      });
      const payload = await res.json();
      if (!res.ok) throw new Error(payload.message || payload.detail || 'Files could not be moved to Trash');
      const data = payload.data || {};
      if (data.failed_count) {
        setError(`${data.failed_count} file${data.failed_count === 1 ? '' : 's'} could not be moved to Trash`);
      }
      setStatus(payload.message || `${data.trashed_count || count} moved to Trash`);
      setSelection([]);
      load(false);
      window.setTimeout(() => setStatus(''), 4000);
    } catch (err) {
      setError(err.message || 'Files could not be moved to Trash');
      setStatus('');
    } finally {
      setTrashing(false);
    }
  };

  // File ka seedha pata. Isse <a download> banta hai — JS se shuru kiya gaya
  // download Chrome rok deta hai, asli link par kiya gaya click kabhi nahi.
  const downloadHref = (asset) =>
    `${apiBase}/central-artwork.php?action=content&id=${encodeURIComponent(asset.id)}`;

  const selectRoot = (next) => {
    setRoot(next); setCustomer(''); setFolder(''); setSelection([]); setPage(1);
  };

  const resetFilters = () => {
    setRoot(''); setCustomer(''); setFolder(''); setLifecycle(''); setSearch(''); setDebouncedSearch(''); setPage(1);
  };

  // Load the customer's designs whenever an attaching type is picked. A design
  // chosen for one customer must not survive a switch to another, so the
  // selection is cleared with the list.
  useEffect(() => {
    setAttachTo('');
    setPieceSearch('');
    if (!showUpload || !needsAttach || !customer || !apiBase) { setPieces([]); return undefined; }
    let active = true;
    setPiecesLoading(true);
    fetch(`${apiBase}/central-artwork.php?action=pieces&entity_key=${encodeURIComponent(customer)}`, { cache: 'no-store' })
      .then(res => res.json())
      .then(payload => { if (active) setPieces(payload.data?.rows || []); })
      .catch(() => { if (active) setPieces([]); })
      .finally(() => { if (active) setPiecesLoading(false); });
    return () => { active = false; };
  }, [showUpload, needsAttach, customer, apiBase]);

  const matchingPieces = useMemo(() => {
    const needle = pieceSearch.trim().toLowerCase();
    if (!needle) return pieces;
    return pieces.filter(p => `${p.artwork_code} ${p.file_name}`.toLowerCase().includes(needle));
  }, [pieces, pieceSearch]);

  // What the file will actually be called once saved — shown before uploading so
  // the naming is never a surprise.
  const plannedName = useMemo(() => {
    const ext = (uploadFiles[0]?.file.name.split('.').pop() || 'png').toLowerCase();
    if (needsAttach) return attachedPiece ? `${attachedPiece.artwork_code}-${uploadLifecycle}.${ext}` : null;
    return `AW-<code>-<next number>-${uploadLifecycle}.${ext}`;
  }, [needsAttach, attachedPiece, uploadLifecycle, uploadFiles]);

  // Upload handlers — queue any number of files; images get a thumbnail preview.
  const addUploadFiles = (fileList) => {
    const incoming = Array.from(fileList || []);
    if (!incoming.length) return;
    incoming.forEach((file) => {
      if (file.type.startsWith('image/')) {
        const reader = new FileReader();
        reader.onload = (ev) => setUploadFiles(prev => prev.map(item => item.file === file ? { ...item, preview: ev.target.result } : item));
        reader.readAsDataURL(file);
      }
    });
    setUploadFiles(prev => [...prev, ...incoming.map(file => ({ file, preview: null }))]);
  };

  const handleUploadFileChange = (e) => {
    addUploadFiles(e.target.files);
    e.target.value = ''; // allow re-picking the same file after removing it
  };

  const removeUploadFile = (index) => setUploadFiles(prev => prev.filter((_, i) => i !== index));

  const handleUpload = async () => {
    if (!uploadFiles.length || !apiBase) return;
    if (!customer) { setUploadMessage('Please select a customer first'); return; }
    if (needsAttach && !attachTo) { setUploadMessage('Pick the source this file belongs to'); return; }
    setUploading(true);
    setUploadMessage('');
    let ok = 0;
    const failures = [];
    for (const { file } of uploadFiles) {
      try {
        const formData = new FormData();
        formData.append('file', file);
        formData.append('entity_key', customer);
        formData.append('lifecycle_code', uploadLifecycle);
        if (needsAttach && attachTo) formData.append('attach_to', attachTo);
        const res = await fetch(`${apiBase}/central-artwork.php?action=upload`, {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${localStorage.getItem('auth_token') || ''}` },
          body: formData,
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.message || data.detail || data.error || 'Upload failed');
        ok += 1;
      } catch (err) {
        failures.push(`${file.name}: ${err.message || 'failed'}`);
      }
    }
    if (failures.length) {
      setUploadMessage(`${ok} uploaded, ${failures.length} failed — ${failures[0]}`);
    } else {
      setUploadMessage(`${ok} file${ok === 1 ? '' : 's'} uploaded to Nextcloud!`);
      setUploadFiles([]);
    }
    load(false);
    if (!failures.length) {
      setTimeout(() => { setShowUpload(false); setUploadMessage(''); }, 1500);
    }
    setUploading(false);
  };

  const closeUploadModal = () => {
    setShowUpload(false);
    setUploadFiles([]);
    setUploadMessage('');
    setAttachTo('');
    setPieceSearch('');
  };

  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const activeFilters = Boolean(root || customer || folder || lifecycle || debouncedSearch.trim());
  const rootTotal = facets.roots.reduce((sum, item) => sum + item.files, 0);

  return (
    <div className={`vault-page ${selected ? 'has-preview' : ''}`}>
      <header className="vault-header">
        <div>
          <h1 className="vault-title">Artwork Vault</h1>
          <p className="vault-subtitle">
            Every customer file from Nextcloud, live — open one here, save it back as a WRK file.
          </p>
        </div>
        <div className="vault-header-actions">
          <button type="button" className="vault-btn vault-btn-primary" onClick={() => setShowUpload(true)}>
            ↑ Upload Artwork
          </button>
          <span className={`vault-live ${live ? 'is-live' : ''}`}>
            <i /> {live ? 'Live' : 'Reconnecting…'}
          </span>
        </div>
      </header>

      {/* Leads and purchase orders are separate worlds with their own folder
          conventions, so they are picked first and never shown mixed. */}
      <div className="vault-sources">
        {/* Switching source clears the customer too: the picker is scoped to the
            source, so a customer carried over from the other one would filter
            the grid down to nothing with no visible reason why. */}
        <button type="button" className={!root ? 'active' : ''} onClick={() => selectRoot('')}>
          All sources <span>{rootTotal.toLocaleString()}</span>
        </button>
        {facets.roots.map(item => (
          <button
            key={item.key}
            type="button"
            className={root === item.key ? 'active' : ''}
            onClick={() => selectRoot(item.key)}
          >
            {item.key} <span>{item.files.toLocaleString()}</span>
          </button>
        ))}
      </div>

      <div className="vault-filters">
        <CustomerPicker
          customers={facets.customers}
          value={customer}
          onChange={(value) => { setCustomer(value); setFolder(''); setPage(1); }}
        />
        <input
          className="vault-search"
          placeholder="Search file name, artwork code, lead or customer…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <select className="vault-select" value={lifecycle} onChange={(e) => { setLifecycle(e.target.value); setPage(1); }}>
          <option value="">All stages</option>
          {facets.lifecycles.filter(item => item.key !== '—' && item.key.toUpperCase() !== 'OUT').map(item => (
            <option key={item.key} value={item.key}>
              {(LIFECYCLE[item.key]?.label) || item.key} ({item.files})
            </option>
          ))}
        </select>
        {activeFilters && <button type="button" className="vault-btn vault-btn-ghost" onClick={resetFilters}>Clear</button>}
        <div className="vault-viewtoggle" role="group" aria-label="View">
          <button type="button" className={view === 'cards' ? 'active' : ''} aria-pressed={view === 'cards'} onClick={() => chooseView('cards')}>▦ Cards</button>
          <button type="button" className={view === 'list' ? 'active' : ''} aria-pressed={view === 'list'} onClick={() => chooseView('list')}>☰ List</button>
        </div>
      </div>

      <div className="vault-tabs">
        <button type="button" className={!folder ? 'active' : ''} onClick={() => { setFolder(''); setPage(1); }}>
          All folders <span>{total}</span>
        </button>
        {/* Empty folders stay on the strip: a customer's Mockups folder exists
            in Nextcloud whether or not anything has been put in it yet. */}
        {facets.folders.map(item => (
          <button
            key={item.key}
            type="button"
            className={`${folder === item.key ? 'active' : ''} ${item.files ? '' : 'is-empty'}`}
            onClick={() => { setFolder(item.key); setPage(1); }}
          >
            {item.key} <span>{item.files}</span>
          </button>
        ))}
      </div>

      {error && <div className="vault-error">{error}</div>}

      {loading && !rows.length && <div className="vault-empty"><p>Loading the vault…</p></div>}

      {!loading && !rows.length && (
        <div className="vault-empty">
          <p>{folder ? `Nothing in ${folder} yet` : 'No artwork matches these filters'}</p>
          <span>
            {folder
              ? 'The folder exists in Nextcloud — anything dropped into it shows up here within seconds.'
              : activeFilters
                ? 'Clear the filters to see the whole vault.'
                : 'Files uploaded to Nextcloud appear here within seconds.'}
          </span>
        </div>
      )}

      {rows.length > 0 && (
        <>
          {view === 'cards' ? (
            <div className="vault-grid">
              {rows.map(asset => (
                <VaultCard
                  key={asset.id}
                  asset={asset}
                  apiBase={apiBase}
                  selected={selection.some(a => a.id === asset.id)}
                  onSelect={(next) => { toggleSelected(next); setStatus(''); }}
                />
              ))}
            </div>
          ) : (
            <div className="vault-list">
              <div className="vault-list-head" aria-hidden="true">
                <span /><span>File</span><span>Lead / Customer</span><span>Folder</span><span>Stage</span>
                <span className="vault-row-num">Size</span><span className="vault-row-num">Modified</span>
              </div>
              {rows.map(asset => (
                <VaultRow
                  key={asset.id}
                  asset={asset}
                  apiBase={apiBase}
                  selected={selection.some(a => a.id === asset.id)}
                  onSelect={(next) => { toggleSelected(next); setStatus(''); }}
                />
              ))}
            </div>
          )}

          <div className="vault-pager">
            <button type="button" className="vault-btn vault-btn-ghost" disabled={page <= 1} onClick={() => setPage(p => Math.max(1, p - 1))}>← Previous</button>
            <span>
              {(page - 1) * PAGE_SIZE + 1}–{Math.min(page * PAGE_SIZE, total)} of {total.toLocaleString()} files
              {pages > 1 && ` · page ${page} of ${pages}`}
            </span>
            <button type="button" className="vault-btn vault-btn-ghost" disabled={page >= pages} onClick={() => setPage(p => Math.min(pages, p + 1))}>Next →</button>
          </div>
        </>
      )}

      {/* Ek file chuni = uska apna panel (badi tasveer + uske saare buttons).
          Kai files chuni = neeche wali patti, jahan wahi kaam hain jo poore set
          par chal sakte hain. Dono ek saath kabhi nahi — warna ek hi button do
          jagah dikhta aur samajh nahi aata ke kaunsa kis par chalega. */}
      {selected && (
        <aside className="vault-preview" aria-label="Artwork preview">
          <header className="vault-preview-head">
            <div>
              <strong title={selected.file_name}>{selected.file_name}</strong>
              <span>{selected.entity_name || 'Unlinked'}</span>
            </div>
            <button type="button" className="vault-preview-close" aria-label="Close preview" onClick={() => { setSelection([]); setStatus(''); }}>×</button>
          </header>

          <div className="vault-preview-scroll">
            <PreviewStage asset={selected} apiBase={apiBase} />

            <div className="vault-preview-meta">
              <PreviewRow label="Folder" value={selected.folder} />
              <PreviewRow label="Stage" value={LIFECYCLE[selected.lifecycle_code]?.label || selected.lifecycle_code} />
              <PreviewRow label="Artwork code" value={selected.artwork_code} />
              <PreviewRow label="Size" value={fileSize(selected.file_size_bytes)} />
              <PreviewRow label="Modified" value={formatDate(selected.source_modified_at)} />
            </div>

            <div className="vault-preview-actions">
              <h3>Open in</h3>
              <div className="vault-preview-btns">
                {TARGETS.map(target => (
                  <button
                    key={target.page}
                    type="button"
                    className={`vault-btn ${target.primary ? 'vault-btn-primary' : ''}`}
                    disabled={Boolean(opening)}
                    onClick={() => openIn(target)}
                  >
                    {opening === target.page ? 'Opening…' : target.label}
                  </button>
                ))}
              </div>
              <h3>Send to</h3>
              <div className="vault-preview-btns">
                {/* Leaves the app, so it opens in its own tab — a generation
                    run is long, and losing the vault behind it helps nobody.
                    Whatever comes back is saved as this design's next WRK
                    version, in this customer's Artworks folder. */}
                <a
                  className={`vault-btn ${GENERATOR_RE.test(selected.file_name) ? '' : 'is-off'}`}
                  href={GENERATOR_RE.test(selected.file_name)
                    ? `${GENERATOR_URL}/?asset=${encodeURIComponent(selected.id)}&path=${encodeURIComponent(selected.path || '')}`
                    : undefined}
                  target="_blank"
                  rel="noreferrer"
                  title={GENERATOR_RE.test(selected.file_name)
                    ? 'Open this artwork in the Artwork Generator'
                    : 'The generator takes .png .jpg .jpeg .webp'}
                >
                  Artwork Generator ↗
                </a>
              </div>
              <h3>File</h3>
              <div className="vault-preview-btns">
                <a className="vault-btn" href={downloadHref(selected)} download={selected.file_name}>Download</a>
                {onSendToTasks && (
                  <button
                    type="button"
                    className="vault-btn vault-btn-task"
                    onClick={() => { onSendToTasks(selection); setSelection([]); setStatus(''); }}
                  >
                    Send to Task Management
                  </button>
                )}
                <button type="button" className="vault-btn vault-btn-danger" disabled={trashing} onClick={trashSelection}>
                  {trashing ? 'Moving…' : '🗑 Trash'}
                </button>
              </div>
            </div>

            {status && <div className="vault-preview-status">{status}</div>}
          </div>
        </aside>
      )}

      {selection.length > 1 && (
        <div className="vault-actionbar">
          <div className="vault-actionbar-file">
            <strong>{selection.length} files selected</strong>
            <span>{selection.slice(0, 3).map(a => a.file_name).join(', ')}{selection.length > 3 ? ` +${selection.length - 3} more` : ''}</span>
          </div>
          <div className="vault-actionbar-actions">
            {onSendToTasks && (
              <button
                type="button"
                className="vault-btn vault-btn-task"
                onClick={() => { onSendToTasks(selection); setSelection([]); setStatus(''); }}
              >
                Send to Task Management ({selection.length})
              </button>
            )}
            <button
              type="button"
              className="vault-btn vault-btn-danger"
              disabled={trashing}
              onClick={trashSelection}
            >
              {trashing ? 'Moving…' : `🗑 Trash (${selection.length})`}
            </button>
            <button type="button" className="vault-btn vault-btn-ghost" onClick={() => { setSelection([]); setStatus(''); }}>Clear</button>
          </div>
          {status && <div className="vault-actionbar-status">{status}</div>}
          <div className="vault-actionbar-status">Pick a single file to open it in a studio tool.</div>
        </div>
      )}

      {/* Upload Modal */}
      {showUpload && (
        <div className="vault-upload-overlay" onClick={closeUploadModal}>
          <div className="vault-upload-modal" onClick={(e) => e.stopPropagation()}>
            <div className="vault-upload-header">
              <h2>Upload Artwork</h2>
              <button className="vault-upload-close" onClick={closeUploadModal}>×</button>
            </div>
            <div className="vault-upload-body">
              {/* Customer & Folder info */}
              <div className="vault-upload-context">
                <div className="vault-upload-field">
                  <label>Customer</label>
                  <span className={customer ? 'has-value' : 'no-value'}>
                    {customer ? (facets.customers.find(c => c.key === customer)?.name || customer) : 'Select a customer from the vault first'}
                  </span>
                </div>
                <div className="vault-upload-field">
                  <label>Folder</label>
                  <span className={folder ? 'has-value' : 'no-value'}>
                    {folder || 'Artworks (default)'}
                  </span>
                </div>
              </div>

              {/* Lifecycle Selection */}
              <div className="vault-upload-field">
                <label>File Type</label>
                <div className="vault-upload-lifecycle-grid">
                  {UPLOAD_LIFECYCLES.map(lc => (
                    <button
                      key={lc.code}
                      type="button"
                      className={`vault-upload-lc-btn ${uploadLifecycle === lc.code ? 'active' : ''}`}
                      onClick={() => setUploadLifecycle(lc.code)}
                    >
                      <span className={`vault-life vault-life-${LIFECYCLE[lc.code]?.tone || 'src'}`}>{lc.code}</span>
                      <span>{lc.label}</span>
                    </button>
                  ))}
                </div>
              </div>

              {/* Which design this file belongs to. A working/final file is a new
                  stage of an existing design, so it inherits that design's code
                  and only its suffix changes. */}
              {needsAttach && (
                <div className="vault-upload-field">
                  <label>
                    Which design is this {UPLOAD_LIFECYCLES.find(l => l.code === uploadLifecycle)?.label.toLowerCase()} for?
                    <span className="vault-upload-required"> required</span>
                  </label>
                  {!customer ? (
                    <div className="vault-attach-empty">Select a customer first.</div>
                  ) : piecesLoading ? (
                    <div className="vault-attach-empty">Loading designs…</div>
                  ) : !pieces.length ? (
                    <div className="vault-attach-empty">This customer has no coded design yet — upload its source (SRC) first.</div>
                  ) : (
                    <>
                      <input
                        className="vault-picker-search vault-attach-search"
                        placeholder={`Search ${pieces.length} designs…`}
                        value={pieceSearch}
                        onChange={(e) => setPieceSearch(e.target.value)}
                      />
                      <div className="vault-attach-list">
                        {matchingPieces.map(piece => (
                          <button
                            key={piece.id}
                            type="button"
                            className={`vault-attach-row ${attachTo === piece.id ? 'active' : ''}`}
                            onClick={() => setAttachTo(piece.id)}
                          >
                            <img
                              className="vault-attach-thumb"
                              alt=""
                              loading="lazy"
                              src={`${apiBase}/central-artwork.php?action=thumb&id=${encodeURIComponent(piece.id)}&w=80&h=80&v=${encodeURIComponent(piece.preview_key || '')}`}
                              onError={(e) => { e.currentTarget.style.visibility = 'hidden'; }}
                            />
                            <span className="vault-attach-info">
                              <span className="vault-attach-code">{piece.artwork_code}</span>
                              <span className="vault-attach-file">{piece.file_name}</span>
                            </span>
                            {piece.lifecycle_code && (
                              <span className={`vault-life vault-life-${LIFECYCLE[piece.lifecycle_code]?.tone || 'src'}`}>{piece.lifecycle_code}</span>
                            )}
                          </button>
                        ))}
                        {!matchingPieces.length && <div className="vault-attach-empty">No design matches “{pieceSearch}”</div>}
                      </div>
                    </>
                  )}
                </div>
              )}

              {/* File Drop Zone — accepts one or many files */}
              <div
                className={`vault-upload-dropzone ${uploadFiles.length ? 'has-file' : ''}`}
                onClick={() => uploadInputRef.current?.click()}
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => { e.preventDefault(); addUploadFiles(e.dataTransfer.files); }}
              >
                {uploadFiles.length ? (
                  <div className="vault-upload-list" onClick={(e) => e.stopPropagation()}>
                    {uploadFiles.map((item, i) => (
                      <div className="vault-upload-list-row" key={`${item.file.name}-${i}`}>
                        {item.preview
                          ? <img src={item.preview} alt="" className="vault-upload-list-thumb" />
                          : <span className="vault-upload-file-icon">📄</span>}
                        <span className="vault-upload-list-name" title={item.file.name}>{item.file.name}</span>
                        <span className="vault-upload-size">{fileSize(item.file.size)}</span>
                        <button type="button" className="vault-upload-list-remove" onClick={() => removeUploadFile(i)}>×</button>
                      </div>
                    ))}
                    <div className="vault-upload-list-add">+ Add more files</div>
                  </div>
                ) : (
                  <div className="vault-upload-placeholder">
                    <span className="vault-upload-icon">↑</span>
                    <span>Drop files here or click to browse</span>
                    <span className="vault-upload-hint">PNG, JPG, PDF — one or many at once</span>
                  </div>
                )}
                <input
                  ref={uploadInputRef}
                  type="file"
                  multiple
                  accept="image/*,.pdf,.ai,.eps,.svg"
                  style={{ display: 'none' }}
                  onChange={handleUploadFileChange}
                />
              </div>

              {/* Exactly what the saved file will be called, before it is sent. */}
              {uploadFiles.length > 0 && plannedName && (
                <div className="vault-upload-plan">
                  Will save as <strong>{plannedName}</strong>
                  {uploadFiles.length > 1 && <span> (then …02, …03 for the rest)</span>}
                </div>
              )}

              {uploadMessage && (
                <div className={`vault-upload-message ${uploadMessage.includes('upload') && !uploadMessage.includes('failed') ? 'success' : 'error'}`}>
                  {uploadMessage}
                </div>
              )}
            </div>
            <div className="vault-upload-footer">
              <button className="vault-btn" onClick={closeUploadModal}>Cancel</button>
              <button
                className="vault-btn vault-btn-primary"
                onClick={handleUpload}
                disabled={!uploadFiles.length || !customer || uploading || (needsAttach && !attachTo)}
              >
                {uploading ? 'Uploading…' : `Upload to Vault${uploadFiles.length > 1 ? ` (${uploadFiles.length})` : ''}`}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default Vault;
