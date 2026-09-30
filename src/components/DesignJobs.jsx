import React, { useState, useEffect, useCallback, useRef } from 'react';
import { detectApiBase } from '../utils/apiConfig';
import { authFetch } from '../utils/authFetch';
import './UserManagement.css';
import './DesignJobs.css';

// Design Jobs: the people side of the Design Studio API. Everything the API or an
// AI agent makes lands here for the decisions the system may not take itself —
// agent review of a mockup, the customer's answer, artwork clean-up review, and
// QA release of a gang sheet's print files.

const STAGE = {
  agent_review: { title: 'Agent review', yes: 'Approve mockup', no: 'Reject', hint: 'Check garment, colour, placement and size before the customer sees it.' },
  customer: { title: 'Customer decision', yes: 'Customer approved', no: 'Customer rejected', hint: 'Record what the customer said and where (e.g. "WhatsApp, 30 Sep").' },
  artwork_review: { title: 'Artwork review', yes: 'Approve cleaned artwork', no: 'Reject', hint: 'Background removal can take pixels the design needs. Compare before and after.' },
  qa: { title: 'QA — release for print', yes: 'Release for print', no: 'Reject', hint: 'Check sizes, quantities and artwork against the order. Print files unlock only after this.' },
};

const fmt = (v) => v ? new Date(v).toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' }) : '—';

async function api(path, options = {}) {
  const base = await detectApiBase();
  const res = await authFetch(base, path, { ...options, headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...(options.headers || {}) } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok && res.status !== 202) {
    const err = new Error(data.error?.message || `Request failed (HTTP ${res.status})`);
    err.detail = data.error;
    throw err;
  }
  return data;
}

function Warnings({ list }) {
  if (!list?.length) return null;
  return (
    <ul className="dj-warnings">
      {list.map((w, i) => <li key={i}><code>{w.code}</code> {w.message}</li>)}
    </ul>
  );
}

function Facts({ rows }) {
  return (
    <dl className="dj-facts">
      {rows.filter(r => r[1] !== undefined && r[1] !== null && r[1] !== '').map(([k, v]) => (
        <React.Fragment key={k}><dt>{k}</dt><dd>{v}</dd></React.Fragment>
      ))}
    </dl>
  );
}

function SubjectBody({ approval, subject, parent }) {
  if (!subject) return <div className="dj-loading">Loading…</div>;
  if (approval.subject_type === 'mockup') {
    const g = subject.garment || {};
    return (
      <div className="dj-body">
        <a href={subject.mockup_url} target="_blank" rel="noreferrer" className="dj-image checker"><img src={subject.mockup_url} alt="Mockup" /></a>
        <div>
          <Facts rows={[
            ['Garment', [g.style || g.type, g.color, g.size, g.side?.toUpperCase()].filter(Boolean).join(' · ')],
            ['Placement', subject.placement?.name?.replace(/_/g, ' ')],
            ['Print size', `${subject.final_print_width_in}" × ${subject.final_print_height_in}"`],
            ['Requested width', subject.requested_print_width_in ? `${subject.requested_print_width_in}"` : '—'],
            ['Scale', subject.scale_status?.replace(/_/g, ' ')],
            ['Artwork', subject.artwork && `${subject.artwork.artwork_id} · ${subject.artwork.width_px}×${subject.artwork.height_px} px (${subject.artwork.ratio}) · ${subject.artwork.effective_dpi} DPI`],
            ['Garment photo', g.photo ? g.photo.name : 'none — plain shirt drawn from size chart'],
          ]} />
          <Warnings list={subject.warnings} />
        </div>
      </div>
    );
  }
  if (approval.subject_type === 'gangsheet') {
    return (
      <div className="dj-body">
        <div className="dj-sheets">
          {(subject.sheets || []).map(s => (
            <a key={s.index} href={s.preview_url} target="_blank" rel="noreferrer" className="dj-sheet">
              <img src={s.preview_url} alt={`Sheet ${s.index}`} />
              <span>Sheet {s.index}: {s.width_in}" × {s.length_in}" · {s.pieces} pcs</span>
            </a>
          ))}
        </div>
        <div>
          <Facts rows={[
            ['Film', `${subject.film_width_in}" wide · ${subject.length_in}" total`],
            ['Pieces', subject.layout?.total_pieces],
            ['Utilisation', subject.layout ? `${Math.round(subject.layout.film_utilization * 100)}%` : null],
            ['Estimate', subject.layout ? `$${subject.layout.estimated_price} (${subject.layout.price_basis})` : null],
          ]} />
          <table className="dj-items">
            <thead><tr><th>Item</th><th>Size</th><th>Qty</th><th>Source</th></tr></thead>
            <tbody>
              {(subject.artwork_list || []).map(it => (
                <tr key={it.item}><td>{it.name}</td><td>{it.width_in}" × {it.height_in}"</td><td>{it.quantity}</td><td>{it.mockup_job_id || it.artwork_id}</td></tr>
              ))}
            </tbody>
          </table>
          <Warnings list={subject.warnings} />
        </div>
      </div>
    );
  }
  // artwork
  return (
    <div className="dj-body">
      <div className="dj-compare">
        {parent && <figure><a href={parent.file_url} target="_blank" rel="noreferrer" className="dj-image checker"><img src={parent.file_url} alt="Before" /></a><figcaption>Before · {parent.width_px}×{parent.height_px}</figcaption></figure>}
        <figure><a href={subject.file_url} target="_blank" rel="noreferrer" className="dj-image checker"><img src={subject.file_url} alt="After" /></a><figcaption>After · {subject.width_px}×{subject.height_px}</figcaption></figure>
      </div>
      <div>
        <Facts rows={[
          ['Artwork', `${subject.artwork_id}${subject.name ? ` · ${subject.name}` : ''}`],
          ['Steps', (subject.prep?.steps || []).map(s => s.step === 'remove_background' ? `background removed (${s.mode}, ${Math.round(s.removed_pixel_ratio * 100)}% of pixels)` : s.step).join(' → ')],
          ['Background now', subject.background],
        ]} />
        <Warnings list={subject.warnings} />
      </div>
    </div>
  );
}

function ApprovalCard({ approval, subject, parent, onDecided }) {
  const [notes, setNotes] = useState('');
  const [override, setOverride] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const stage = STAGE[approval.stage];
  const needsOverride = approval.stage === 'qa' && (subject?.warnings || []).some(w => ['ITEM_NOT_CUSTOMER_APPROVED', 'ITEM_NOT_FROM_MOCKUP'].includes(w.code));

  const decide = async (decision) => {
    setBusy(true); setError(null);
    try {
      await api(`/approvals/${approval.approval_id}/decide`, { method: 'POST', body: JSON.stringify({ decision, notes, override_unapproved_items: override }) });
      onDecided();
    } catch (e) { setError(e); }
    setBusy(false);
  };

  return (
    <article className="dj-card" data-approval={approval.approval_id}>
      <header>
        <span className={`dj-stage dj-stage-${approval.stage}`}>{stage.title}</span>
        <strong>{approval.subject_id}</strong>
        {approval.order_id && <span className="dj-order">Order {approval.order_id}</span>}
        <span className="dj-meta">{subject?.requested_by ? `by ${subject.requested_by}` : ''}{subject?.via ? ` · via ${subject.via}` : ''} · {fmt(approval.created_at)}</span>
      </header>
      <SubjectBody approval={approval} subject={subject} parent={parent} />
      <p className="dj-hint">{stage.hint}</p>
      {needsOverride && (
        <label className="dj-override">
          <input type="checkbox" checked={override} onChange={e => setOverride(e.target.checked)} />
          Release even though some items are not from a customer-approved mockup (a note is required)
        </label>
      )}
      <textarea className="dj-notes" placeholder="Notes (optional; required for an override)" value={notes} onChange={e => setNotes(e.target.value)} rows={2} />
      {error && (
        <div className="um-alert um-alert-error">
          {error.message}
          {error.detail?.items && <ul>{error.detail.items.map((it, i) => <li key={i}>Item {it.item + 1}: {it.reason}</li>)}</ul>}
        </div>
      )}
      <div className="dj-actions">
        <button className="um-btn um-btn-danger" disabled={busy} onClick={() => decide('rejected')}>{stage.no}</button>
        <button className="um-btn um-btn-primary" disabled={busy} onClick={() => decide('approved')}>{busy ? 'Saving…' : stage.yes}</button>
      </div>
    </article>
  );
}

function DesignJobs() {
  const [tab, setTab] = useState('queue');
  const [order, setOrder] = useState('');
  const [approvals, setApprovals] = useState([]);
  const [total, setTotal] = useState(0);
  const loadSeq = useRef(0);
  const [subjects, setSubjects] = useState({});
  const [jobs, setJobs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    // A slower earlier load (e.g. before a filter was applied) must not overwrite a newer one.
    const seq = ++loadSeq.current;
    const current = () => seq === loadSeq.current;
    setLoading(true); setError('');
    const qs = order.trim() ? `&order_id=${encodeURIComponent(order.trim())}` : '';
    try {
      if (tab === 'queue') {
        const { approvals: list, total: count } = await api(`/approvals?status=pending&include=subjects${qs}`);
        const loaded = {};
        for (const a of list) loaded[`${a.subject_type}:${a.subject_id}`] = { subject: a.subject, parent: a.subject?.parent || null };
        if (!current()) return;
        setApprovals(list); setTotal(count); setSubjects(loaded);
      } else {
        const { jobs: list } = await api(`/jobs?limit=100${qs}`);
        if (!current()) return;
        setJobs(list);
      }
    } catch (e) { if (current()) setError(e.message); }
    if (current()) setLoading(false);
  }, [tab, order]);

  useEffect(() => { load(); }, [tab]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="um-page dj-page">
      <header className="um-header">
        <div>
          <h1 className="um-title">Design Jobs</h1>
          <p className="um-subtitle">Mockups, gang sheets and artwork made through the API or by AI agents. Nothing reaches a customer or the printer until a person approves it here.</p>
        </div>
        <form className="dj-filter" onSubmit={e => { e.preventDefault(); load(); }}>
          <input placeholder="Order id" value={order} onChange={e => setOrder(e.target.value)} />
          <button className="um-btn um-btn-outline" type="submit">Filter</button>
        </form>
      </header>

      <div className="dj-tabs">
        <button className={tab === 'queue' ? 'active' : ''} onClick={() => setTab('queue')}>Needs a decision{tab === 'queue' && !loading ? ` (${total})` : ''}</button>
        <button className={tab === 'jobs' ? 'active' : ''} onClick={() => setTab('jobs')}>All jobs</button>
        <button className="dj-refresh" onClick={load} title="Refresh">↻</button>
      </div>

      {error && <div className="um-alert um-alert-error">{error}</div>}
      {loading ? <div className="um-loading">Loading…</div> : tab === 'queue' ? (
        approvals.length === 0 ? <div className="dj-empty">Nothing is waiting for a decision.</div> : (
          <div className="dj-list">
            {total > approvals.length && <div className="um-alert dj-more">Showing the oldest {approvals.length} of {total} waiting decisions. Filter by order id to find a specific one.</div>}
            {approvals.map(a => {
              const s = subjects[`${a.subject_type}:${a.subject_id}`] || {};
              return <ApprovalCard key={a.approval_id} approval={a} subject={s.subject} parent={s.parent} onDecided={load} />;
            })}
          </div>
        )
      ) : (
        <div className="um-table-wrap dj-table-wrap">
          <table className="um-table">
            <thead><tr><th>Job</th><th>Type</th><th>Order</th><th>Status</th><th>Approvals</th><th>Requested by</th><th>Created</th><th></th></tr></thead>
            <tbody>
              {jobs.length === 0 ? <tr><td colSpan="8" className="um-loading">No jobs yet.</td></tr> : jobs.map(j => {
                const link = j.mockup_url || j.output_url || j.package_url;
                const appr = j.type === 'mockup' ? `agent ${j.agent_status} · customer ${j.customer_status}` : j.type === 'gangsheet' ? `QA ${j.qa_status}` : '—';
                return (
                  <tr key={j.job_id}>
                    <td><code>{j.job_id}</code></td>
                    <td>{j.type}</td>
                    <td>{j.order_id || '—'}</td>
                    <td><span className={`dj-status dj-status-${j.status}`}>{j.status}</span>{j.warnings?.length ? <span className="dj-warn-count" title={j.warnings.map(w => w.code).join(', ')}> ⚠ {j.warnings.length}</span> : null}</td>
                    <td>{appr}</td>
                    <td>{j.requested_by || '—'}<br /><span className="um-date">via {j.via}</span></td>
                    <td className="um-date">{fmt(j.created_at)}</td>
                    <td>{link ? <a href={link} target="_blank" rel="noreferrer">Open</a> : ''}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export default DesignJobs;
