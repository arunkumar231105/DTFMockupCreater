import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { detectApiBase } from '../utils/apiConfig';
import './Vault.css';
import './Gallery.css';

// ── Gallery ──────────────────────────────────────────────────────────────────
// Every customer file, the way the Vault shows it — but nothing is uploaded or
// edited here. The job of this page is to put each file where it belongs:
// pick a customer, select files, and mark them. A mark moves the file into the
// right folder of that customer with the standard name and number, and every
// mark is written to the gallery database with who did it and when.
//
// Listing, thumbnails and customers come from the same vault the Vault page
// reads; marking goes through api/gallery.php.

const PAGE_SIZE = 60;
const VIEW_KEY = 'dsGalleryView';

const MARKS = [
  { code: 'SRC', label: 'Source', hint: 'Finished artwork · references/', tone: 'src' },
  { code: 'REF', label: 'Reference', hint: 'To recreate from · references/', tone: 'ref' },
  { code: 'WRK', label: 'Working', hint: 'Artworks/ · WRK01, WRK02…', tone: 'wrk' },
  { code: 'FNL', label: 'Final', hint: 'final_files/ · FNL01…', tone: 'fnl' },
  { code: 'FNLA', label: 'Approved', hint: 'final_files/ · FNLA01…', tone: 'fnla' },
  { code: 'DOCS', label: 'Document', hint: 'Payment, invoice, sizes · Documents/', tone: 'docs' },
  { code: 'RECEIVED', label: 'Received', hint: 'Order the customer got · leaves the gallery', tone: 'recv', confirm: true },
  { code: 'DUPLICATE', label: 'Duplicate', hint: 'Same file more than once · nothing moves', tone: 'dup' },
  { code: 'TRASH', label: 'Trash', hint: 'Trash/<customer>/<month> · leaves the gallery', tone: 'trash', confirm: true },
];
const MARK_BY_CODE = Object.fromEntries(MARKS.map((m) => [m.code, m]));

const STAGE_LABEL = {
  SRC: 'Source', REF: 'Reference', WRK: 'Working', FNL: 'Final', FNLA: 'Approved', DOC: 'Document',
  MU: 'Mockup', MOCK: 'Mockup', GS: 'Gang sheet', OUT: 'Sent',
};
const STAGE_TONE = { SRC: 'src', REF: 'ref', WRK: 'wrk', FNL: 'fnl', FNLA: 'fnla', DOC: 'docs', MU: 'mu', MOCK: 'mu', GS: 'gs', OUT: 'out' };

const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const DATE_PRESETS = [['', 'Any date'], ['today', 'Today'], ['7d', 'Last 7 days'], ['30d', 'Last 30 days'], ['month', 'This month'], ['custom', 'Custom range…']];
function presetRange(key) {
  const now = new Date();
  const back = (n) => { const d = new Date(now); d.setDate(d.getDate() - n); return ymd(d); };
  if (key === 'today') return [ymd(now), ymd(now)];
  if (key === '7d') return [back(6), ymd(now)];
  if (key === '30d') return [back(29), ymd(now)];
  if (key === 'month') return [ymd(new Date(now.getFullYear(), now.getMonth(), 1)), ymd(now)];
  return ['', ''];
}

const IMAGE_RE = /\.(png|jpe?g|webp|gif|bmp|svg|avif)$/i;
const isImage = (a) => IMAGE_RE.test(a?.file_name || '') || /^image\//.test(a?.mime_type || '');
const fmtSize = (b) => (!b ? '' : b > 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`);
const fmtWhen = (v) => (v ? new Date(v).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '');
const fmtLeadTime = (ts) => (ts ? new Date(Number(ts)).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '');
const authHeaders = () => {
  let token = '';
  try { token = localStorage.getItem('auth_token') || ''; } catch { /* private window */ }
  return token ? { Authorization: `Bearer ${token}` } : {};
};

function StageBadge({ code }) {
  if (!code) return null;
  const c = String(code).toUpperCase();
  return <span className={`gl-stage gl-tone-${STAGE_TONE[c] || 'out'}`}>{c}</span>;
}

// ── Customer picker: section (LMS / CRM 360) + searchable customer list ───────
function CustomerPicker({ customers, value, onChange }) {
  const [open, setOpen] = useState(false);
  const [term, setTerm] = useState('');
  const [group, setGroup] = useState('lms');
  const boxRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const close = (e) => { if (boxRef.current && !boxRef.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);

  const selected = customers.find((c) => c.key === value);
  const inGroup = useMemo(() => customers
    .filter((c) => !c.crm_group || c.crm_group === group)
    .sort((a, b) => (Number(b.lead_ts) || 0) - (Number(a.lead_ts) || 0)), [customers, group]);
  const matches = useMemo(() => {
    const needle = term.trim().toLowerCase();
    return needle ? inGroup.filter((c) => `${c.name} ${c.lead_no || ''} ${c.reference || ''}`.toLowerCase().includes(needle)) : inGroup;
  }, [inGroup, term]);
  const countOf = (g) => customers.filter((c) => !c.crm_group || c.crm_group === g).length;

  return (
    <>
      <select className="gl-select" value={group} onChange={(e) => { setGroup(e.target.value); if (selected?.crm_group && selected.crm_group !== e.target.value) onChange(''); }}>
        <option value="lms">LMS ({countOf('lms')})</option>
        <option value="crm360">CRM 360 ({countOf('crm360')})</option>
      </select>
      <div className="gl-picker" ref={boxRef}>
        <button type="button" className={`gl-picker-btn ${value ? 'is-set' : ''}`} onClick={() => { setOpen((o) => !o); setTerm(''); }}>
          <span className="gl-picker-label">Customer</span>
          <span className="gl-picker-value">{selected ? <>{selected.lead_no && <b>{selected.lead_no}</b>}{selected.name}</> : 'All customers'}</span>
          <span className="gl-picker-caret">▾</span>
        </button>
        {open && (
          <div className="gl-picker-panel">
            <input className="gl-picker-search" autoFocus placeholder={`Search ${inGroup.length} customers…`} value={term} onChange={(e) => setTerm(e.target.value)} />
            <ul className="gl-picker-list">
              <li><button type="button" className={!value ? 'active' : ''} onClick={() => { onChange(''); setOpen(false); }}>All customers</button></li>
              {matches.map((c) => (
                <li key={c.key}>
                  <button type="button" className={value === c.key ? 'active' : ''} onClick={() => { onChange(c.key); setOpen(false); }}>
                    {c.lead_no && <span className="gl-picker-lead">{c.lead_no}</span>}
                    <span className="gl-picker-main">
                      <span className="gl-picker-name">{c.name}</span>
                      {c.lead_ts ? <span className="gl-picker-date">{fmtLeadTime(c.lead_ts)}</span> : null}
                    </span>
                    <span className="gl-picker-count">{c.files}</span>
                  </button>
                </li>
              ))}
              {!matches.length && <li className="gl-picker-none">No customer matches “{term}”</li>}
            </ul>
          </div>
        )}
      </div>
    </>
  );
}

// ── The page ─────────────────────────────────────────────────────────────────
export default function Gallery() {
  const [apiBase, setApiBase] = useState(null);
  const [root, setRoot] = useState('');
  const [customer, setCustomer] = useState('');
  const [lifecycle, setLifecycle] = useState('');
  const [datePreset, setDatePreset] = useState('');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  const [page, setPage] = useState(1);
  const [view, setView] = useState(() => { try { return localStorage.getItem(VIEW_KEY) === 'list' ? 'list' : 'cards'; } catch { return 'cards'; } });

  const [rows, setRows] = useState([]);
  const [total, setTotal] = useState(0);
  const [facets, setFacets] = useState({ roots: [], customers: [], lifecycles: [] });
  const [summary, setSummary] = useState({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const [selection, setSelection] = useState(() => new Set());
  const [focus, setFocus] = useState(null);
  const [history, setHistory] = useState({ loading: false, data: null });
  const [busy, setBusy] = useState('');
  const [confirm, setConfirm] = useState(null);
  const [toast, setToast] = useState(null);

  useEffect(() => { detectApiBase().then(setApiBase).catch(() => setApiBase('/api')); }, []);
  useEffect(() => { const t = setTimeout(() => { setDebounced(search); setPage(1); }, 300); return () => clearTimeout(t); }, [search]);
  useEffect(() => { if (!toast) return undefined; const t = setTimeout(() => setToast(null), 6000); return () => clearTimeout(t); }, [toast]);

  const query = useMemo(() => {
    const p = new URLSearchParams();
    if (root) p.set('root', root);
    if (customer) p.set('entity_key', customer);
    if (lifecycle) p.set('lifecycle', lifecycle);
    if (debounced.trim()) p.set('search', debounced.trim());
    if (dateFrom) p.set('from', dateFrom);
    if (dateTo) p.set('to', dateTo);
    return p;
  }, [root, customer, lifecycle, debounced, dateFrom, dateTo]);

  const loadSummary = useCallback(async (list) => {
    if (!apiBase || !list.length) { setSummary({}); return; }
    try {
      const res = await fetch(`${apiBase}/gallery.php?action=summary&ids=${list.map((r) => r.id).join(',')}`, { headers: authHeaders(), cache: 'no-store' });
      const json = await res.json();
      setSummary(json?.data || {});
    } catch { /* badges are extra — the grid still works */ }
  }, [apiBase]);

  const load = useCallback(async () => {
    if (!apiBase) return;
    setLoading(true);
    try {
      const listParams = new URLSearchParams(query);
      listParams.set('page', String(page));
      listParams.set('limit', String(PAGE_SIZE));
      const [listRes, facetRes] = await Promise.all([
        fetch(`${apiBase}/central-artwork.php?action=vault&${listParams}`, { cache: 'no-store' }),
        fetch(`${apiBase}/central-artwork.php?action=facets&${query}`, { cache: 'no-store' }),
      ]);
      if (!listRes.ok) throw new Error(`The vault is not answering (${listRes.status})`);
      const data = (await listRes.json()).data || {};
      const list = data.rows || [];
      setRows(list);
      setTotal(data.total || 0);
      if (facetRes.ok) {
        const f = (await facetRes.json()).data;
        if (f) setFacets({ roots: f.roots || [], customers: f.customers || [], lifecycles: f.lifecycles || [] });
      }
      setError('');
      loadSummary(list);
    } catch (e) {
      setError(e.message || 'The gallery could not be loaded');
    } finally {
      setLoading(false);
    }
  }, [apiBase, query, page, loadSummary]);

  useEffect(() => { load(); }, [load]);

  const loadHistory = useCallback(async (id) => {
    if (!apiBase || !id) return;
    setHistory({ loading: true, data: null });
    try {
      const res = await fetch(`${apiBase}/gallery.php?action=history&id=${encodeURIComponent(id)}`, { headers: authHeaders(), cache: 'no-store' });
      const json = await res.json();
      setHistory({ loading: false, data: json?.data || null });
    } catch { setHistory({ loading: false, data: null }); }
  }, [apiBase]);

  useEffect(() => { if (focus) loadHistory(focus.id); }, [focus, loadHistory]);
  useEffect(() => {
    if (!focus) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') setFocus(null); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [focus]);

  const toggle = (id) => setSelection((prev) => { const next = new Set(prev); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  const allOnPage = rows.length > 0 && rows.every((r) => selection.has(r.id));
  const toggleAll = () => setSelection((prev) => {
    const next = new Set(prev);
    if (allOnPage) rows.forEach((r) => next.delete(r.id)); else rows.forEach((r) => next.add(r.id));
    return next;
  });

  const post = async (action, body) => {
    const res = await fetch(`${apiBase}/gallery.php?action=${action}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...authHeaders() }, body: JSON.stringify(body),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok || json.success === false) throw new Error(json.error || `Gallery said ${res.status}`);
    return json.data;
  };

  // Ask first for anything that takes files out of the gallery, or moves many at once.
  const askMark = (code, ids = [...selection]) => {
    if (!ids.length) return;
    const mark = MARK_BY_CODE[code];
    if (code === 'DUPLICATE' && ids.length < 2) { setToast({ ok: false, text: 'Select at least two copies of the same file to mark them as duplicates.' }); return; }
    if (mark.confirm || ids.length > 1 || code === 'DUPLICATE') setConfirm({ code, ids });
    else runMark(code, ids);
  };

  const runMark = async (code, ids) => {
    setConfirm(null);
    setBusy(code);
    try {
      if (code === 'DUPLICATE') {
        const primary = focus && ids.includes(focus.id) ? focus.id : ids[0];
        await post('duplicate', { ids, primary_id: primary });
        setToast({ ok: true, text: `${ids.length} files grouped as duplicates — ${rows.find((r) => r.id === primary)?.file_name || 'the first'} is kept as the original.` });
      } else {
        const r = await post('mark', { ids, mark: code });
        const moved = r.done.length;
        const first = r.done[0]?.file_name;
        setToast({
          ok: !r.failed.length,
          text: r.failed.length
            ? `${moved} marked ${code}, ${r.failed.length} could not be — ${r.failed[0].error}`
            : `${moved} file${moved === 1 ? '' : 's'} marked ${code}${first ? ` · ${first}${moved > 1 ? ' …' : ''}` : ''}`,
        });
        if (focus && ids.includes(focus.id)) {
          const d = r.done.find((x) => x.id === focus.id);
          if (d && (code === 'TRASH' || code === 'RECEIVED')) setFocus(null);
          else if (d) setFocus((f) => ({ ...f, id: d.new_id || f.id, file_name: d.file_name, lifecycle_code: code === 'DOCS' ? null : code, artwork_code: d.artwork_code || f.artwork_code }));
        }
      }
      setSelection(new Set());
      await load();
      settleLater();
    } catch (e) {
      setToast({ ok: false, text: e.message });
    } finally {
      setBusy('');
    }
  };

  // The vault picks up moved files a few seconds after the fact; look once more
  // after it has, so the grid never keeps showing a file at its old place.
  const settleTimer = useRef(null);
  const settleLater = () => {
    clearTimeout(settleTimer.current);
    settleTimer.current = setTimeout(() => { load(); }, 9000);
  };
  useEffect(() => () => clearTimeout(settleTimer.current), []);

  const derive = async (asset) => {
    setBusy('derive');
    try {
      const r = await post('derive', { id: asset.id });
      setToast({ ok: true, text: `New source ${r.file_name} created from ${asset.file_name}` });
      await load();
      settleLater();
      loadHistory(asset.id);
    } catch (e) {
      setToast({ ok: false, text: e.message });
    } finally { setBusy(''); }
  };

  const chooseDate = (key) => {
    setDatePreset(key);
    if (key !== 'custom') { const [f, t] = presetRange(key); setDateFrom(f); setDateTo(t); }
    setPage(1);
  };
  const resetFilters = () => {
    setRoot(''); setCustomer(''); setLifecycle(''); setSearch(''); setDebounced('');
    setDatePreset(''); setDateFrom(''); setDateTo(''); setPage(1);
  };
  const chooseView = (v) => { setView(v); try { localStorage.setItem(VIEW_KEY, v); } catch { /* ok */ } };

  const thumb = (a, w = 320, h = 240) => `${apiBase}/central-artwork.php?action=thumb&id=${encodeURIComponent(a.id)}&w=${w}&h=${h}&v=${encodeURIComponent(a.preview_key || '')}`;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const rootTotal = facets.roots.reduce((s, r) => s + r.files, 0);
  const activeFilters = Boolean(root || customer || lifecycle || debounced.trim() || dateFrom || dateTo);

  const Chips = ({ a }) => {
    const s = summary[a.id];
    if (!s) return null;
    return (
      <span className="gl-chips">
        {s.children ? <span className="gl-chip gl-chip-src" title="New sources extracted from this reference">{s.children} SRC</span> : null}
        {s.duplicate ? <span className="gl-chip gl-chip-dup">{s.duplicate === 'primary' ? 'ORIGINAL' : 'DUP'}</span> : null}
        {s.mark ? <span className="gl-chip gl-chip-by" title={`Marked ${s.mark} by ${s.marked_by} · ${fmtWhen(s.marked_at)}`}>✓ {s.mark} · {s.marked_by}</span> : null}
      </span>
    );
  };

  return (
    <div className={`gl-page ${focus ? 'has-panel' : ''}`}>
      <header className="gl-header">
        <div>
          <h1 className="gl-title">Gallery</h1>
          <p className="gl-subtitle">Put every customer file where it belongs. Nothing is uploaded or edited here — a mark moves the file to the right folder with its standard name.</p>
        </div>
        <button type="button" className="gl-btn" onClick={load} disabled={loading}>↻ Refresh</button>
      </header>

      <div className="gl-sources">
        <button type="button" className={!root ? 'active' : ''} onClick={() => { setRoot(''); setCustomer(''); setPage(1); }}>All sources <span>{rootTotal.toLocaleString()}</span></button>
        {facets.roots.map((r) => (
          <button key={r.key} type="button" className={root === r.key ? 'active' : ''} onClick={() => { setRoot(r.key); setCustomer(''); setPage(1); }}>
            {r.key} <span>{r.files.toLocaleString()}</span>
          </button>
        ))}
      </div>

      <div className="gl-filters">
        <CustomerPicker customers={facets.customers} value={customer} onChange={(v) => { setCustomer(v); setSelection(new Set()); setPage(1); }} />
        <input className="gl-search" placeholder="Search file name, artwork code or customer…" value={search} onChange={(e) => setSearch(e.target.value)} />
        <select className="gl-select" value={lifecycle} onChange={(e) => { setLifecycle(e.target.value); setPage(1); }}>
          <option value="">All stages</option>
          {facets.lifecycles.filter((l) => l.key !== '—').map((l) => (
            <option key={l.key} value={l.key}>{STAGE_LABEL[l.key] || l.key} ({l.files})</option>
          ))}
        </select>
        <select className="gl-select" value={datePreset} onChange={(e) => chooseDate(e.target.value)}>
          {DATE_PRESETS.map(([k, l]) => <option key={k || 'any'} value={k}>{l}</option>)}
        </select>
        {datePreset === 'custom' && (
          <span className="gl-daterange">
            <input type="date" className="gl-date" value={dateFrom} max={dateTo || undefined} onChange={(e) => { setDateFrom(e.target.value); setPage(1); }} />
            <span>–</span>
            <input type="date" className="gl-date" value={dateTo} min={dateFrom || undefined} onChange={(e) => { setDateTo(e.target.value); setPage(1); }} />
          </span>
        )}
        {activeFilters && <button type="button" className="gl-btn gl-btn-ghost" onClick={resetFilters}>Clear</button>}
        <div className="gl-viewtoggle">
          <button type="button" className={view === 'cards' ? 'active' : ''} onClick={() => chooseView('cards')}>▦ Cards</button>
          <button type="button" className={view === 'list' ? 'active' : ''} onClick={() => chooseView('list')}>☰ List</button>
        </div>
      </div>

      {/* Mark bar — appears as soon as something is selected */}
      <div className={`gl-markbar ${selection.size ? 'is-open' : ''}`}>
        <div className="gl-markbar-count">
          <label className="gl-check"><input type="checkbox" checked={allOnPage} onChange={toggleAll} /> <span>{selection.size ? `${selection.size} selected` : 'Select all on this page'}</span></label>
          {selection.size > 0 && <button type="button" className="gl-link" onClick={() => setSelection(new Set())}>Clear</button>}
        </div>
        <div className="gl-markbar-actions">
          {MARKS.map((m) => (
            <button key={m.code} type="button" title={m.hint} disabled={!selection.size || !!busy}
              className={`gl-mark gl-tone-${m.tone}`} onClick={() => askMark(m.code)}>
              {busy === m.code ? '…' : m.label}
            </button>
          ))}
        </div>
      </div>

      {error && <div className="gl-error">{error}</div>}
      {loading && !rows.length && <div className="gl-empty"><p>Loading the gallery…</p></div>}
      {!loading && !rows.length && !error && (
        <div className="gl-empty"><p>No files match these filters</p><span>Try another customer, stage or date.</span></div>
      )}

      {rows.length > 0 && view === 'cards' && (
        <div className="gl-grid">
          {rows.map((a) => (
            <div key={a.id} className={`gl-card ${selection.has(a.id) ? 'selected' : ''} ${focus?.id === a.id ? 'focused' : ''}`}>
              <button type="button" className="gl-card-img" onClick={() => setFocus(a)} title="Open">
                {isImage(a) ? <img src={thumb(a)} alt={a.file_name} loading="lazy" decoding="async" /> : <span className="gl-ext">{(a.file_name.split('.').pop() || 'FILE').toUpperCase()}</span>}
                <span className="gl-card-stage"><StageBadge code={a.lifecycle_code} /></span>
              </button>
              <label className="gl-card-check" title="Select"><input type="checkbox" checked={selection.has(a.id)} onChange={() => toggle(a.id)} /></label>
              <div className="gl-card-body" onClick={() => setFocus(a)}>
                <div className="gl-card-name" title={a.file_name}>{a.file_name}</div>
                <div className="gl-card-meta">{a.entity_name || 'Unlinked'}{a.folder ? ` · ${a.folder}` : ''}</div>
                <Chips a={a} />
              </div>
            </div>
          ))}
        </div>
      )}

      {rows.length > 0 && view === 'list' && (
        <div className="gl-table-wrap">
          <table className="gl-table">
            <thead>
              <tr>
                <th><input type="checkbox" checked={allOnPage} onChange={toggleAll} /></th>
                <th /><th>File</th><th>Customer</th><th>Folder</th><th>Stage</th><th>Size</th><th>Modified</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((a) => (
                <tr key={a.id} className={`${selection.has(a.id) ? 'selected' : ''} ${focus?.id === a.id ? 'focused' : ''}`}>
                  <td><input type="checkbox" checked={selection.has(a.id)} onChange={() => toggle(a.id)} /></td>
                  <td className="gl-td-thumb" onClick={() => setFocus(a)}>{isImage(a) ? <img src={thumb(a, 96, 96)} alt="" loading="lazy" /> : <span className="gl-ext gl-ext-sm">{(a.file_name.split('.').pop() || '').toUpperCase()}</span>}</td>
                  <td onClick={() => setFocus(a)}><div className="gl-td-name">{a.file_name}</div><div className="gl-td-sub">{a.artwork_code || ''} <Chips a={a} /></div></td>
                  <td>{a.entity_name || 'Unlinked'}</td>
                  <td>{a.folder || ''}</td>
                  <td><StageBadge code={a.lifecycle_code} /></td>
                  <td>{fmtSize(a.file_size_bytes)}</td>
                  <td>{fmtWhen(a.source_modified_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {pages > 1 && (
        <div className="gl-pager">
          <button type="button" className="gl-btn" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>← Previous</button>
          <span>{((page - 1) * PAGE_SIZE + 1).toLocaleString()}–{Math.min(page * PAGE_SIZE, total).toLocaleString()} of {total.toLocaleString()} files · page {page} of {pages}</span>
          <button type="button" className="gl-btn" disabled={page >= pages} onClick={() => setPage((p) => p + 1)}>Next →</button>
        </div>
      )}

      {/* Side panel: the file large, its details, marks and history */}
      {focus && (
        <aside className="gl-panel">
          <div className="gl-panel-head">
            <div className="gl-panel-title" title={focus.file_name}>{focus.file_name}</div>
            <button type="button" className="gl-panel-close" onClick={() => setFocus(null)} aria-label="Close">×</button>
          </div>
          <div className="gl-panel-img">
            {isImage(focus) ? <img src={thumb(focus, 900, 900)} alt={focus.file_name} /> : <span className="gl-ext gl-ext-lg">{(focus.file_name.split('.').pop() || 'FILE').toUpperCase()}</span>}
          </div>
          <dl className="gl-panel-facts">
            <div><dt>Stage</dt><dd><StageBadge code={focus.lifecycle_code} /> {STAGE_LABEL[String(focus.lifecycle_code || '').toUpperCase()] || '—'}</dd></div>
            <div><dt>Design</dt><dd>{focus.artwork_code || 'Not numbered yet'}</dd></div>
            <div><dt>Customer</dt><dd>{focus.entity_name || 'Unlinked'}</dd></div>
            <div><dt>Folder</dt><dd>{focus.folder || '—'}</dd></div>
            <div><dt>Size</dt><dd>{fmtSize(focus.file_size_bytes) || '—'}</dd></div>
            <div><dt>Modified</dt><dd>{fmtWhen(focus.source_modified_at) || '—'}</dd></div>
          </dl>

          <div className="gl-panel-section">
            <div className="gl-panel-label">Mark this file</div>
            <div className="gl-panel-marks">
              {MARKS.filter((m) => m.code !== 'DUPLICATE').map((m) => (
                <button key={m.code} type="button" title={m.hint} disabled={!!busy} className={`gl-mark gl-tone-${m.tone}`} onClick={() => askMark(m.code, [focus.id])}>
                  {busy === m.code ? '…' : m.label}
                </button>
              ))}
            </div>
          </div>

          {String(focus.lifecycle_code || '').toUpperCase() === 'REF' && (
            <div className="gl-panel-section gl-derive">
              <div className="gl-panel-label">Extract a new source</div>
              <p>Keeps this reference as it is and creates a new SRC file with its own design number, linked back to this reference. Use it once for every design you pull out of it.</p>
              <button type="button" className="gl-btn gl-btn-primary" disabled={!!busy} onClick={() => derive(focus)}>
                {busy === 'derive' ? 'Creating…' : '＋ New SRC from this reference'}
              </button>
            </div>
          )}

          <div className="gl-panel-section">
            <div className="gl-panel-label">History</div>
            {history.loading && <p className="gl-muted">Loading…</p>}
            {!history.loading && history.data && (
              <>
                {history.data.links?.length > 0 && (
                  <ul className="gl-links">
                    {history.data.links.map((l, i) => (
                      <li key={i}>
                        {l.parent_asset_id === focus.id
                          ? <>→ <b>{l.child_file_name || l.child_artwork_code}</b> extracted from this</>
                          : <>← extracted from <b>{l.parent_file_name || l.parent_artwork_code}</b></>}
                        <span className="gl-muted"> · {l.created_by} · {fmtWhen(l.created_at)}</span>
                      </li>
                    ))}
                  </ul>
                )}
                {history.data.duplicates?.length > 0 && (
                  <ul className="gl-links">
                    {history.data.duplicates.map((d) => (
                      <li key={d.asset_id}>{d.is_primary ? '★ original' : '⧉ duplicate'} · <b>{d.file_name || d.asset_id}</b></li>
                    ))}
                  </ul>
                )}
                {!history.data.marks?.length && !history.data.links?.length && <p className="gl-muted">Not marked yet.</p>}
                <ol className="gl-timeline">
                  {(history.data.marks || []).map((m) => (
                    <li key={m.id} className={m.status === 'failed' ? 'failed' : ''}>
                      <span className="gl-timeline-dot" />
                      <div>
                        <div className="gl-timeline-head">
                          <StageBadge code={m.from_mark} /> → <span className={`gl-stage gl-tone-${MARK_BY_CODE[m.to_mark]?.tone || STAGE_TONE[m.to_mark] || 'out'}`}>{m.to_mark}</span>
                          {m.status === 'failed' && <span className="gl-failed">failed</span>}
                        </div>
                        {m.to_file_name && m.to_file_name !== m.from_file_name && <div className="gl-timeline-file">{m.from_file_name} → {m.to_file_name}</div>}
                        {m.note && <div className="gl-timeline-note">{m.note}</div>}
                        {m.error && <div className="gl-timeline-note gl-failed-text">{m.error}</div>}
                        <div className="gl-muted">{m.marked_by} · {fmtWhen(m.marked_at)}</div>
                      </div>
                    </li>
                  ))}
                </ol>
              </>
            )}
          </div>
        </aside>
      )}

      {/* Confirm before moving files out of the gallery or moving many at once */}
      {confirm && (
        <div className="gl-overlay" onClick={() => setConfirm(null)}>
          <div className="gl-dialog" onClick={(e) => e.stopPropagation()}>
            <h2>Mark {confirm.ids.length} file{confirm.ids.length === 1 ? '' : 's'} as {MARK_BY_CODE[confirm.code].label}?</h2>
            <p>
              {confirm.code === 'TRASH' && 'They move to Trash/<customer>/<this month> in Nextcloud and leave the gallery. They can be brought back from that folder.'}
              {confirm.code === 'RECEIVED' && 'They move to receive_customer_orders/<customer> in Nextcloud and leave the gallery.'}
              {confirm.code === 'DUPLICATE' && `They are grouped as copies of one file. ${focus && confirm.ids.includes(focus.id) ? 'The file open in the panel' : 'The first selected file'} is kept as the original. Nothing moves.`}
              {!['TRASH', 'RECEIVED', 'DUPLICATE'].includes(confirm.code) && `Each file moves to its customer's ${MARK_BY_CODE[confirm.code].hint.split('·').pop().trim()} and is renamed to the standard (AW-<client>-<number>-${confirm.code === 'DOCS' ? 'DOC' : confirm.code}). Files without a design number get the next free one.`}
            </p>
            <div className="gl-dialog-actions">
              <button type="button" className="gl-btn" onClick={() => setConfirm(null)}>Cancel</button>
              <button type="button" className={`gl-btn ${confirm.code === 'TRASH' ? 'gl-btn-danger' : 'gl-btn-primary'}`} onClick={() => runMark(confirm.code, confirm.ids)}>
                Mark as {MARK_BY_CODE[confirm.code].label}
              </button>
            </div>
          </div>
        </div>
      )}

      {toast && <div className={`gl-toast ${toast.ok ? 'ok' : 'err'}`} onClick={() => setToast(null)}>{toast.text}</div>}
    </div>
  );
}
