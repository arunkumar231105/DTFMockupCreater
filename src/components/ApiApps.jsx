import React, { useState, useEffect } from 'react';
import { detectApiBase } from '../utils/apiConfig';
import { authFetch, apiError } from '../utils/authFetch';
import './ApiApps.css';

// Apps other systems (CRM, AI agents) use to call the Design Studio API. Each app
// gets only the permissions ticked here. "Approve" is for systems where a person
// clicks approve — never for an AI agent.
const SCOPES = [
  { id: 'artwork', label: 'Artwork', hint: '/api/artworks/analyze, /api/artworks/prepare — measure and clean artwork' },
  { id: 'mockup', label: 'Mockup', hint: '/api/mockups/generate, /api/mockups/batch — exact garment mockups' },
  { id: 'gangsheet', label: 'Gang Sheet', hint: '/api/gangsheets/create — DTF sheets (print files released after QA)' },
  { id: 'export', label: 'Export', hint: '/api/exports/package — ZIPs of approved mockups / QA-approved sheets' },
  { id: 'approve', label: 'Approve', hint: '/api/approvals — record a person\'s decision. Never give this to an AI agent.', danger: true },
];
const DEFAULT_SCOPES = ['artwork', 'mockup', 'gangsheet', 'export'];

const PUBLIC_API_BASE = window.location.hostname.endsWith('decoinkssuite.com')
  ? window.location.origin
  : 'https://designstudio.decoinkssuite.com';

const fmtDate = (v) => v ? new Date(v).toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' }) : '—';

function CopyField({ label, value, secret }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try { await navigator.clipboard.writeText(value); }
    catch {
      const t = document.createElement('textarea'); t.value = value; document.body.appendChild(t); t.select(); document.execCommand('copy'); t.remove();
    }
    setCopied(true); setTimeout(() => setCopied(false), 1500);
  };
  return (
    <div className="aa-copy">
      <span className="aa-copy-label">{label}</span>
      <div className={`aa-copy-row ${secret ? 'secret' : ''}`}>
        <code>{value}</code>
        <button type="button" className="um-btn um-btn-sm um-btn-primary" onClick={copy}>{copied ? 'Copied' : 'Copy'}</button>
      </div>
    </div>
  );
}

function ApiApps() {
  const [apps, setApps] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [showCreate, setShowCreate] = useState(false);
  const [name, setName] = useState('');
  const [scopes, setScopes] = useState(DEFAULT_SCOPES);
  const [busy, setBusy] = useState(false);
  const [issued, setIssued] = useState(null); // { name, api_key, api_secret, rotated }
  const [showDocs, setShowDocs] = useState(false);

  const call = async (path, options) => {
    const base = await detectApiBase();
    const res = await authFetch(base, path, options);
    if (!res.ok) throw await apiError(res, 'Request failed');
    return res.json();
  };

  const load = async () => {
    setLoading(true);
    try { setApps((await call('/api-apps.php')).apps || []); setError(''); }
    catch (e) { setError(e.message); }
    setLoading(false);
  };

  useEffect(() => { load(); }, []);

  const post = (action, body) => call(`/api-apps.php?action=${action}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });

  const create = async (e) => {
    e.preventDefault();
    setBusy(true); setError('');
    try {
      const data = await post('create', { name: name.trim(), scopes });
      setIssued({ ...data, rotated: false });
      setShowCreate(false); setName(''); setScopes(DEFAULT_SCOPES);
      load();
    } catch (err) { setError(err.message); }
    setBusy(false);
  };

  const rotate = async (app) => {
    if (!confirm(`Generate a new secret for "${app.name}"?\n\nThe current secret stops working immediately — the other system must be updated with the new one.`)) return;
    try { setIssued({ ...(await post('rotate', { id: app.id })), rotated: true }); load(); }
    catch (err) { setError(err.message); }
  };

  const toggle = async (app) => {
    try { await post('update', { id: app.id, is_active: !app.is_active }); load(); }
    catch (err) { setError(err.message); }
  };

  const toggleScope = async (app, scope) => {
    const next = app.scopes.includes(scope) ? app.scopes.filter(s => s !== scope) : [...app.scopes, scope];
    if (!next.length) { setError('An app needs at least one permission. Disable it instead.'); return; }
    try { await post('update', { id: app.id, scopes: next }); load(); }
    catch (err) { setError(err.message); }
  };

  const remove = async (app) => {
    if (!confirm(`Delete "${app.name}"?\n\nIts key stops working immediately and cannot be restored.`)) return;
    try { await post('delete', { id: app.id }); load(); }
    catch (err) { setError(err.message); }
  };

  return (
    <div className="um-page aa-page">
      <header className="um-header">
        <div>
          <h1 className="um-title">API Apps</h1>
          <p className="um-subtitle">Keys that let other systems and AI agents analyse artwork and make mockups and gang sheets. The vault, orders, customers and users are not reachable with them.</p>
        </div>
        <div className="aa-header-actions">
          <button className="um-btn um-btn-outline" onClick={() => setShowDocs(v => !v)}>{showDocs ? 'Hide' : 'How to use'}</button>
          <button className="um-btn um-btn-primary" onClick={() => { setShowCreate(true); setError(''); }}>+ Create App</button>
        </div>
      </header>

      {error && <div className="um-alert um-alert-error">{error}</div>}

      {showDocs && <ApiDocs />}

      <div className="um-table-wrap">
        <table className="um-table">
          <thead>
            <tr>
              <th>App</th><th>API Key</th><th>Permissions</th><th>Status</th><th>Usage</th><th>Created</th><th></th>
            </tr>
          </thead>
          <tbody>
            {loading ? <tr><td colSpan="7" className="um-loading">Loading...</td></tr>
              : apps.length === 0 ? <tr><td colSpan="7" className="um-loading">No apps yet. Create one to get an API key and secret.</td></tr>
              : apps.map(app => (
                <tr key={app.id} className={!app.is_active ? 'um-inactive' : ''}>
                  <td>
                    <div className="um-user-cell">
                      <span className="um-user-name">{app.name}</span>
                      <span className="um-user-username">secret ····{app.secret_hint}{app.secret_rotated_at ? ` · rotated ${fmtDate(app.secret_rotated_at)}` : ''}</span>
                    </div>
                  </td>
                  <td><code className="aa-key">{app.api_key}</code></td>
                  <td>
                    <div className="aa-scopes">
                      {SCOPES.map(s => (
                        <label key={s.id} className={`aa-scope ${app.scopes.includes(s.id) ? 'on' : ''} ${s.danger ? 'danger' : ''}`} title={s.hint}>
                          <input type="checkbox" checked={app.scopes.includes(s.id)} onChange={() => toggleScope(app, s.id)} />
                          {s.label}
                        </label>
                      ))}
                    </div>
                  </td>
                  <td>
                    <button className={`um-status-btn ${app.is_active ? 'active' : 'inactive'}`} onClick={() => toggle(app)} title={app.is_active ? 'Click to disable' : 'Click to enable'}>
                      {app.is_active ? '● Active' : '○ Disabled'}
                    </button>
                  </td>
                  <td>
                    <div className="um-user-cell">
                      <span>{Number(app.request_count).toLocaleString()} total · {app.requests_24h} today</span>
                      <span className="um-date">{Number(app.errors_24h) > 0 ? `${app.errors_24h} failed today · ` : ''}last used {fmtDate(app.last_used_at)}</span>
                    </div>
                  </td>
                  <td className="um-date">{fmtDate(app.created_at)}<br />{app.created_by_name || ''}</td>
                  <td>
                    <div className="um-actions">
                      <button className="um-btn um-btn-sm" onClick={() => rotate(app)}>New Secret</button>
                      <button className="um-btn um-btn-sm um-btn-danger" onClick={() => remove(app)}>Delete</button>
                    </div>
                  </td>
                </tr>
              ))}
          </tbody>
        </table>
      </div>

      {showCreate && (
        <div className="um-modal-overlay" onClick={() => setShowCreate(false)}>
          <div className="um-modal" onClick={e => e.stopPropagation()}>
            <div className="um-modal-header">
              <h2>Create App</h2>
              <button className="um-modal-close" onClick={() => setShowCreate(false)}>×</button>
            </div>
            <form onSubmit={create} className="um-form">
              <div className="um-field">
                <label>App name</label>
                <input autoFocus required maxLength={120} value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Shopify Store, Customer Portal" />
              </div>
              <div className="um-field" style={{ marginTop: 14 }}>
                <label>What may this app do?</label>
                <div className="aa-scope-pick">
                  {SCOPES.map(s => (
                    <label key={s.id} className={`um-page-check ${s.danger ? 'aa-danger' : ''}`}>
                      <input type="checkbox" checked={scopes.includes(s.id)}
                        onChange={() => setScopes(prev => prev.includes(s.id) ? prev.filter(x => x !== s.id) : [...prev, s.id])} />
                      <span><strong>{s.label}</strong><br /><small>{s.hint}</small></span>
                    </label>
                  ))}
                </div>
              </div>
              <div className="um-form-actions">
                <button type="button" className="um-btn um-btn-outline" onClick={() => setShowCreate(false)}>Cancel</button>
                <button type="submit" className="um-btn um-btn-primary" disabled={busy || !name.trim() || scopes.length === 0}>{busy ? 'Creating…' : 'Create App'}</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {issued && (
        <div className="um-modal-overlay">
          <div className="um-modal">
            <div className="um-modal-header">
              <h2>{issued.rotated ? 'New secret' : 'App created'} — {issued.name}</h2>
            </div>
            <div className="um-form">
              <div className="aa-warning">Copy the secret now. It is shown only this once — Design Studio keeps only a fingerprint of it. If it is lost, generate a new one.</div>
              <CopyField label="API Base URL" value={PUBLIC_API_BASE} />
              <CopyField label="API Key" value={issued.api_key} />
              <CopyField label="API Secret" value={issued.api_secret} secret />
              <div className="um-form-actions">
                <button className="um-btn um-btn-primary" onClick={() => setIssued(null)}>I have copied it</button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function ApiDocs() {
  const b = PUBLIC_API_BASE;
  return (
    <div className="aa-docs">
      <p>Every request sends the app's credentials as <code>X-API-Key</code> and <code>X-API-Secret</code> headers (or <code>Authorization: Bearer dsk_…:dss_…</code>). Add <code>order_id</code>, <code>customer_id</code> and <code>lead_id</code> so everything links back to the order. Limit: 60 requests per minute per app. Output links are signed and expire after 7 days — <code>GET /api/jobs/&#123;job_id&#125;</code> always returns fresh ones.</p>

      <h3>1 · Analyze artwork</h3>
      <p>Measured by code, not AI vision: pixel size, ratio, true alpha vs white / checkerboard background, padding, DPI, warnings. The same file always gets the same <code>artwork_id</code>.</p>
      <pre>{`curl -X POST ${b}/api/artworks/analyze \\
  -H "X-API-Key: dsk_…" -H "X-API-Secret: dss_…" \\
  -F artwork=@logo.png -F order_id=SO_123`}</pre>
      <p className="aa-small"><code>POST /api/artworks/prepare</code> with <code>artwork_id</code>, <code>remove_background</code> (auto, white, checkerboard, fast, balanced, precision), <code>trim</code>, <code>target_print_width_in</code> makes a cleaned copy. A copy with its background removed waits for a person's review on the Design Jobs page.</p>

      <h3>2 · Exact mockup</h3>
      <pre>{`curl -X POST ${b}/api/mockups/generate \\
  -H "X-API-Key: dsk_…" -H "X-API-Secret: dss_…" -H "Content-Type: application/json" \\
  -d '{ "order_id": "SO_123", "artwork_id": "ART_…",
        "garment_style": "Gildan 5000", "garment_size": "Adult L", "garment_color": "Black",
        "side": "back", "placement": "back_center",
        "requested_print_width_in": 12.5, "max_print_width_in": 13.5, "generate_label": true }'`}</pre>
      <p className="aa-small">Returns <code>job_id</code>, <code>mockup_url</code>, <code>final_print_width_in</code> / <code>final_print_height_in</code>, <code>scale_status</code> and <code>warnings</code>. The following are listed by <code>GET /api/mockups/options</code>:</p>
      <ul className="aa-small">
        <li>Placements: front_center, left_chest, right_chest, pocket, back_center, back_neck, custom.</li>
        <li>Sizes and colours.</li>
      </ul>
      <p className="aa-small">Many colours / sizes at once: <code>POST /api/mockups/batch</code>.</p>

      <h3>3 · Gang sheet</h3>
      <pre>{`curl -X POST ${b}/api/gangsheets/create \\
  -H "X-API-Key: dsk_…" -H "X-API-Secret: dss_…" -H "Content-Type: application/json" \\
  -d '{ "order_id": "SO_123", "film_width_in": 22,
        "items": [ { "mockup_job_id": "MJ_…", "quantity": 24 } ] }'`}</pre>
      <p className="aa-small">Items taken from a mockup print at that mockup's size. The job is queued: poll <code>GET /api/jobs/&#123;job_id&#125;</code>.</p>
      <ul className="aa-small">
        <li>Previews come right away.</li>
        <li><code>print_url</code> appears only after QA releases the sheet on the Design Jobs page.</li>
      </ul>

      <h3>4 · Approvals and packages</h3>
      <p className="aa-small">People decide on the Design Jobs page:</p>
      <ul className="aa-small">
        <li>Agent review, then the customer's answer, for mockups.</li>
        <li>Artwork review for cleaned-up artwork.</li>
        <li>QA for gang sheets.</li>
      </ul>
      <p className="aa-small">A CRM can record them too with the Approve permission: <code>POST /api/approvals/&#123;approval_id&#125;/decide</code> with <code>decision</code> and <code>decided_by</code>.</p>
      <p className="aa-small"><code>POST /api/exports/package</code> with <code>order_id</code> and <code>output_type</code> returns a ZIP:</p>
      <ul className="aa-small">
        <li><code>customer_preview</code>: agent-approved mockups plus a size report.</li>
        <li><code>production</code>: QA-approved print files plus a layout report.</li>
      </ul>

      <h3>AI agents (MCP)</h3>
      <p className="aa-small">MCP endpoint (Streamable HTTP): <code>{b}/mcp</code> with the same headers, or <code>{b}/mcp?token=dsk_…:dss_…</code> for clients that only take a URL. The tools are:</p>
      <ul className="aa-small">
        <li><code>get_mockup_options</code></li>
        <li><code>analyze_artwork</code></li>
        <li><code>prepare_artwork</code></li>
        <li><code>generate_mockup</code></li>
        <li><code>create_gangsheet</code></li>
        <li><code>export_customer_preview</code></li>
        <li><code>get_design_job_status</code></li>
      </ul>
      <p className="aa-small">There is no approval tool. Inside Design Studio the same tools are offered to in-browser agents through WebMCP.</p>
    </div>
  );
}

export default ApiApps;
