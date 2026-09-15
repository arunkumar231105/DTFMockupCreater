// One task, open inside Design Studio. Same state machine, same permissions and
// same data as Task Management — the API decides what is allowed; this screen
// only shows the actions the current status and role permit. What it adds is the
// artwork: every attached vault file can be opened straight into a studio tool,
// which is the whole point of running the task here rather than in the other tab.
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { taskApi, initials } from '../utils/taskApi';
import TaskVoiceRecorder from './TaskVoiceRecorder';
import TaskVaultUpload from './TaskVaultUpload';

const TABS = ['Details', 'Artwork', 'Checklist', 'Files', 'Comments', 'Activity'];

const STATUS_TONE = {
  Pending: 'idle', Assigned: 'info', Accepted: 'info', 'In Progress': 'info',
  Waiting: 'warn', 'On Hold': 'warn', Reopened: 'warn', Submitted: 'review',
  Completed: 'done', Rejected: 'danger', Overdue: 'danger', Cancelled: 'idle',
};

export function StatusBadge({ status }) {
  return <span className={`tm-status tm-status-${STATUS_TONE[status] || 'idle'}`}>{status}</span>;
}

export function PriorityFlag({ priority }) {
  return <span className={`tm-priority tm-priority-${(priority || 'low').toLowerCase()}`}>⚑ {priority}</span>;
}

/**
 * An artwork's picture. The live vault thumbnail is preferred — it stays right
 * when a file is re-saved — but a vault hiccup, or a file the thumbnailer cannot
 * render, must not leave a broken image: the preview stored with the task is the
 * fallback, and the extension is the last resort.
 */
export function ArtworkThumb({ artwork, thumbUrlFor, className }) {
  const live = thumbUrlFor?.(artwork) || null;
  const stored = artwork?.thumbData || null;
  const [src, setSrc] = useState(live || stored);

  useEffect(() => { setSrc(live || stored); }, [live, stored]);

  if (!src) return <span className="tm-art-ext">{(artwork?.fileName?.split('.').pop() || 'FILE').toUpperCase()}</span>;
  return (
    <img
      src={src}
      alt={artwork.fileName}
      title={artwork.fileName}
      loading="lazy"
      className={className}
      onError={() => setSrc((current) => (current !== stored ? stored : null))}
    />
  );
}

export function isOverdue(t) {
  return Boolean(t.dueAt) && new Date(t.dueAt) < new Date() && !['Completed', 'Cancelled', 'Submitted'].includes(t.status);
}

const fmtDateTime = (v) => (v ? new Date(v).toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—');
const fmtSize = (b) => (b == null ? '' : b > 1e6 ? (b / 1e6).toFixed(1) + ' MB' : Math.max(1, Math.round(b / 1024)) + ' KB');

function useElapsed(startedAt, running) {
  const [, force] = useState(0);
  useEffect(() => {
    if (!running) return undefined;
    const id = setInterval(() => force((x) => x + 1), 1000);
    return () => clearInterval(id);
  }, [running]);
  if (!startedAt) return null;
  const s = Math.max(0, Math.floor((Date.now() - new Date(startedAt)) / 1000));
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
}

function TaskDetail({ taskId, currentUser, onBack, onOpenArtwork, thumbUrlFor, openingArtwork, canDelete, onDeleted }) {
  const [task, setTask] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);
  const [actErr, setActErr] = useState(null);
  const [tab, setTab] = useState('Details');
  const [comment, setComment] = useState('');
  const [voiceNote, setVoiceNote] = useState(null);
  const [voiceTranscript, setVoiceTranscript] = useState(null);
  const [submitOpen, setSubmitOpen] = useState(false);
  const [summary, setSummary] = useState('');
  const [assignOpen, setAssignOpen] = useState(false);
  const [assignUsers, setAssignUsers] = useState([]);
  const [reminded, setReminded] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const fileRef = useRef(null);

  const load = useCallback(async () => {
    try {
      const d = await taskApi.task(taskId);
      setTask(d.task);
      setLoadError(null);
    } catch (e) {
      setLoadError(e.message);
    } finally {
      setLoading(false);
    }
  }, [taskId]);

  useEffect(() => { setLoading(true); load(); }, [load]);

  const elapsed = useElapsed(task?.startedAt, task?.status === 'In Progress');

  if (loading) return <div className="tm-empty">Loading task…</div>;
  if (loadError || !task) {
    return (
      <div className="tm-empty">
        <p>{loadError || 'Task not found'}</p>
        <button type="button" className="tm-btn" onClick={onBack}>← Back to tasks</button>
      </div>
    );
  }

  const isAssignee = task.assignedUser?.id === currentUser.id;
  const isReviewer = task.createdBy?.id === currentUser.id || currentUser.role === 'ADMIN';
  const late = isOverdue(task);
  const requiredLeft = task.checklist.filter((c) => c.isRequired && !c.isCompleted).length;

  const act = async (fn) => {
    setActErr(null);
    try { await fn(); await load(); }
    catch (e) { setActErr(e.message); }
  };

  const doTransition = (event, extra = {}) => act(async () => {
    await taskApi.transition(task.id, { event, ...extra });
    setSubmitOpen(false);
    setSummary('');
  });

  const openAssign = async () => {
    setActErr(null);
    setAssignOpen((o) => !o);
    if (!assignUsers.length) {
      try { const r = await taskApi.assignableUsers(); setAssignUsers(r.users || []); }
      catch (e) { setActErr(e.message); }
    }
  };

  const addComment = () => act(async () => {
    if (!comment.trim() && !voiceNote) return;
    await taskApi.comment(task.id, comment, voiceNote || undefined, (voiceNote && voiceTranscript) || undefined);
    setComment(''); setVoiceNote(null); setVoiceTranscript(null);
  });

  const doUpload = (file) => act(async () => {
    if (!file) return;
    if (file.size > 25 * 1024 * 1024) throw new Error('File must be under 25 MB');
    setUploading(true);
    try {
      const dataUrl = await new Promise((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(r.result);
        r.onerror = () => reject(new Error('File could not be read'));
        r.readAsDataURL(file);
      });
      await taskApi.uploadFile(task.id, { fileName: file.name, fileType: file.type, dataUrl });
    } finally { setUploading(false); }
  });

  // Deleting is the one action that does not come back through load() — the task is
  // gone, so the page has to leave with it.
  const doDelete = async () => {
    const label = `${task.taskNo} — ${task.title}`;
    if (!window.confirm(`Delete ${label}?\n\nIt disappears from Task Management for everyone. The record is kept for the audit trail, but nobody can open it again.`)) return;
    setActErr(null);
    setDeleting(true);
    try {
      const r = await taskApi.deleteTask(task.id, 'Deleted from Design Studio');
      onDeleted?.(r.taskNo || task.taskNo);
    } catch (e) {
      setActErr(e.message);
      setDeleting(false);
    }
  };

  const doDownload = (f) => act(async () => {
    const r = await taskApi.getFile(task.id, f.id);
    const a = document.createElement('a');
    a.href = r.file.dataUrl;
    a.download = f.fileName;
    document.body.appendChild(a);
    a.click();
    a.remove();
  });

  return (
    <div className="tm-detail">
      <button type="button" className="tm-link-btn tm-back" onClick={onBack}>← Back to tasks</button>

      <div className="tm-card tm-detail-head">
        <div className="tm-detail-title">
          <h2>{task.title}</h2>
          <span className="tm-detail-sub">{task.taskNo} · {task.entityType} · {task.entityId}</span>
        </div>

        <div className="tm-detail-meta">
          <StatusBadge status={late ? 'Overdue' : task.status} />
          <PriorityFlag priority={task.priority} />
          {task.dueAt && <span className={late ? 'tm-due-late' : 'tm-due'}>Due {fmtDateTime(task.dueAt)}</span>}
          <span className="tm-assign-wrap">
            {task.assignedUser ? (
              <span className="tm-person">
                <span className="tm-avatar tm-avatar-sm" style={{ background: task.assignedUser.color }}>{initials(task.assignedUser.name)}</span>
                {task.assignedUser.name}
              </span>
            ) : <span className="tm-muted">Unassigned</span>}
            {isReviewer && !['Completed', 'Cancelled'].includes(task.status) && (
              <button type="button" className="tm-btn tm-btn-xs" onClick={openAssign}>
                {task.assignedUser ? 'Reassign' : 'Assign'}
              </button>
            )}
            {assignOpen && (
              <>
                <div className="tm-dropdown-scrim" onClick={() => setAssignOpen(false)} />
                <div className="tm-dropdown">
                  {assignUsers.length === 0 ? <div className="tm-dropdown-empty">Loading…</div> : assignUsers.map((u) => (
                    <button
                      key={u.id}
                      type="button"
                      onClick={() => act(async () => { await taskApi.assignTask(task.id, { assignedUserId: u.id }); setAssignOpen(false); })}
                    >
                      <span className="tm-avatar tm-avatar-xs" style={{ background: u.color || '#605E5C' }}>{initials(u.name)}</span>
                      <span className="tm-dropdown-name">{u.name} <em>· {u.role}</em></span>
                      {u.openTasks != null && <span className="tm-dropdown-count">{u.openTasks} open</span>}
                    </button>
                  ))}
                </div>
              </>
            )}
          </span>

          <span className="tm-detail-actions">
            {elapsed && task.status === 'In Progress' && <span className="tm-timer">{elapsed}</span>}
            {isAssignee && ['Assigned', 'Accepted', 'Reopened'].includes(task.status) && (
              <button type="button" className="tm-btn tm-btn-primary" onClick={() => doTransition('start')}>▶ Start Task</button>
            )}
            {isAssignee && task.status === 'In Progress' && (
              <>
                <button type="button" className="tm-btn tm-btn-warn" onClick={() => doTransition('pause')}>⏸ Pause</button>
                <button type="button" className="tm-btn tm-btn-primary" onClick={() => setSubmitOpen(true)}>↑ Submit</button>
              </>
            )}
            {isAssignee && task.status === 'On Hold' && (
              <button type="button" className="tm-btn tm-btn-primary" onClick={() => doTransition('resume')}>▶ Resume</button>
            )}
            {isReviewer && task.status === 'Submitted' && (
              <>
                <button type="button" className="tm-btn tm-btn-danger-soft" onClick={() => doTransition('reject', { notes: 'Rejected from Design Studio' })}>✕ Reject</button>
                <button type="button" className="tm-btn tm-btn-success" onClick={() => doTransition('approve')}>✓ Approve</button>
              </>
            )}
            {isReviewer && task.status === 'Rejected' && (
              <button type="button" className="tm-btn" onClick={() => doTransition('reopen')}>↺ Reopen</button>
            )}
            {canDelete && (
              <button type="button" className="tm-btn tm-btn-danger-soft" disabled={deleting} onClick={doDelete}>
                🗑 {deleting ? 'Deleting…' : 'Delete Task'}
              </button>
            )}
            {isReviewer && !isAssignee && task.assignedUser && late && (
              <button
                type="button"
                className="tm-btn tm-btn-danger-soft"
                disabled={reminded}
                onClick={() => act(async () => { await taskApi.remind(task.id); setReminded(true); })}
              >
                🔔 {reminded ? 'Reminder Sent' : 'Send Reminder'}
              </button>
            )}
          </span>
        </div>

        {actErr && <div className="tm-alert tm-alert-error">{actErr}</div>}

        {submitOpen && (
          <div className="tm-submit-box">
            <textarea
              className="tm-input tm-textarea"
              value={summary}
              onChange={(e) => setSummary(e.target.value)}
              placeholder="What was done? (optional summary for the reviewer)"
            />
            <div className="tm-submit-actions">
              {requiredLeft > 0 && <span className="tm-warn-text">{requiredLeft} required checklist item(s) still open</span>}
              <button type="button" className="tm-btn" onClick={() => setSubmitOpen(false)}>Cancel</button>
              <button type="button" className="tm-btn tm-btn-primary" onClick={() => doTransition('submit', { completionSummary: summary || undefined })}>
                Submit for review
              </button>
            </div>
          </div>
        )}
      </div>

      <div className="tm-card tm-tabs-card">
        <div className="tm-tabs">
          {TABS.map((x) => (
            <button key={x} type="button" className={tab === x ? 'active' : ''} onClick={() => setTab(x)}>
              {x}
              {x === 'Artwork' && task.artworks?.length > 0 && <em> ({task.artworks.length})</em>}
              {x === 'Checklist' && task.checklist.length > 0 && <em> ({task.checklist.filter((c) => c.isCompleted).length}/{task.checklist.length})</em>}
              {x === 'Comments' && task.comments.length > 0 && <em> ({task.comments.length})</em>}
            </button>
          ))}
        </div>

        <div className="tm-tab-body">
          {tab === 'Details' && (
            <div className="tm-stack">
              {task.description
                ? <p className="tm-desc">{task.description}</p>
                : <p className="tm-muted">No written instructions.</p>}

              {(task.voiceNote || task.voiceNotes?.length > 0) && (
                <div className="tm-subtle-box">
                  <div className="tm-box-title">🎤 Voice instruction{(task.voiceNotes?.length || 0) + (task.voiceNote ? 1 : 0) > 1 ? 's' : ''}</div>
                  {task.voiceNote && (
                    <div className="tm-voice-note">
                      <audio controls src={task.voiceNote} className="tm-audio" />
                      {task.voiceTranscript && <p className="tm-transcript">“{task.voiceTranscript}”</p>}
                    </div>
                  )}
                  {(task.voiceNotes || []).map((n) => (
                    <div key={n.id} className="tm-voice-note">
                      <audio controls src={n.audioData} className="tm-audio" />
                      {n.transcript && <p className="tm-transcript">“{n.transcript}”</p>}
                    </div>
                  ))}
                </div>
              )}

              <dl className="tm-facts">
                <div><dt>Assigned by</dt><dd>{task.createdBy?.name || '—'}</dd></div>
                <div><dt>Created</dt><dd>{fmtDateTime(task.createdAt)}</dd></div>
                <div><dt>Task type</dt><dd>{task.taskType}</dd></div>
                <div><dt>Department</dt><dd>{task.department?.name || '—'}</dd></div>
                <div><dt>Estimated</dt><dd>{task.estimatedMinutes ? `${task.estimatedMinutes} min` : '—'}</dd></div>
                <div><dt>Started</dt><dd>{fmtDateTime(task.startedAt)}</dd></div>
              </dl>

              {task.completionSummary && (
                <div className="tm-subtle-box">
                  <div className="tm-box-title">Completion summary</div>
                  <p>{task.completionSummary}</p>
                </div>
              )}
            </div>
          )}

          {tab === 'Artwork' && (
            !task.artworks?.length ? (
              <p className="tm-muted">No vault artwork attached to this task.</p>
            ) : (
              <div className="tm-art-grid tm-art-grid-lg">
                {task.artworks.map((a) => (
                  <figure key={a.id} className="tm-art">
                    <span className="tm-art-img">
                      <ArtworkThumb artwork={a} thumbUrlFor={thumbUrlFor} />
                    </span>
                    <figcaption title={a.fileName}>{a.fileName}</figcaption>
                    <span className="tm-art-sub">
                      {a.customerName || 'Unlinked'}{a.folder ? ` · ${a.folder}` : ''}{a.sizeBytes ? ` · ${fmtSize(a.sizeBytes)}` : ''}
                    </span>
                    {onOpenArtwork && (
                      <button
                        type="button"
                        className="tm-btn tm-btn-primary tm-btn-xs tm-art-open"
                        disabled={openingArtwork === a.assetId}
                        onClick={() => onOpenArtwork(a)}
                      >
                        {openingArtwork === a.assetId ? 'Opening…' : 'Open in Artwork Editor'}
                      </button>
                    )}
                  </figure>
                ))}
              </div>
            )
          )}

          {tab === 'Checklist' && (
            <ul className="tm-checklist">
              {task.checklist.length === 0 && <li className="tm-muted">No checklist items.</li>}
              {task.checklist.map((c) => (
                <li key={c.id}>
                  <button
                    type="button"
                    className={`tm-check ${c.isCompleted ? 'done' : ''}`}
                    disabled={!isAssignee}
                    onClick={() => act(() => taskApi.toggleChecklist(task.id, c.id, !c.isCompleted))}
                  >✓</button>
                  <span className={c.isCompleted ? 'tm-check-done' : ''}>{c.item}</span>
                  {c.isRequired && !c.isCompleted && <em className="tm-req">required</em>}
                </li>
              ))}
            </ul>
          )}

          {tab === 'Files' && (
            <div className="tm-stack">
              {/* Vault me file — Vault ke Upload Artwork jaisa: type (REF/SRC/WRK/FNL/FNLA) aur
                  WRK/FNL ke liye kis design ki hai. Task ke Artwork tab me bhi jud jaati hai. */}
              <TaskVaultUpload task={task} onChanged={load} />
              <div>
                <input
                  ref={fileRef}
                  type="file"
                  style={{ display: 'none' }}
                  accept="image/*,application/pdf,.ai,.psd,.eps,.zip"
                  onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; doUpload(f); }}
                />
                <button type="button" className="tm-btn tm-btn-primary" disabled={uploading} onClick={() => fileRef.current?.click()}>
                  ↑ {uploading ? 'Uploading…' : 'Attach to task only'}
                </button>
                <span className="tm-muted tm-inline-hint">Kept on the task, not saved to the vault · up to 25 MB</span>
              </div>
              {task.files?.length ? (
                <ul className="tm-file-list">
                  {task.files.map((f) => (
                    <li key={f.id}>
                      <span className="tm-file-name">{f.fileName}</span>
                      <span className="tm-muted">{f.kind} · {fmtSize(f.sizeBytes)} · {fmtDateTime(f.createdAt)}</span>
                      <button type="button" className="tm-btn tm-btn-xs" onClick={() => doDownload(f)}>Download</button>
                      <button
                        type="button"
                        className="tm-btn tm-btn-xs tm-danger-hover"
                        onClick={() => { if (window.confirm(`Delete ${f.fileName}?`)) act(() => taskApi.deleteFile(task.id, f.id)); }}
                      >Delete</button>
                    </li>
                  ))}
                </ul>
              ) : <p className="tm-muted">No files attached yet.</p>}
            </div>
          )}

          {tab === 'Comments' && (
            <div className="tm-stack">
              <div className="tm-comment-list">
                {task.comments.length === 0 && <p className="tm-muted">No comments yet.</p>}
                {task.comments.map((c) => (
                  <div key={c.id} className="tm-comment">
                    <span className="tm-avatar tm-avatar-sm" style={{ background: c.commentedBy?.color || '#605E5C' }}>
                      {initials(c.commentedBy?.name || '?')}
                    </span>
                    <div>
                      <div className="tm-comment-head">
                        <strong>{c.commentedBy?.name}</strong>
                        <span className="tm-muted">{fmtDateTime(c.createdAt)}</span>
                      </div>
                      <p>{c.commentText}</p>
                      {c.audioData && <audio controls src={c.audioData} className="tm-audio" />}
                      {c.audioTranscript && <p className="tm-transcript">“{c.audioTranscript}”</p>}
                    </div>
                  </div>
                ))}
              </div>
              <div className="tm-comment-box">
                <textarea
                  className="tm-input tm-textarea"
                  value={comment}
                  onChange={(e) => setComment(e.target.value)}
                  placeholder="Write a comment…"
                />
                <TaskVoiceRecorder
                  value={voiceNote}
                  onChange={(audio, transcript) => { setVoiceNote(audio); setVoiceTranscript(transcript); }}
                />
                <button type="button" className="tm-btn tm-btn-primary" onClick={addComment} disabled={!comment.trim() && !voiceNote}>
                  Send
                </button>
              </div>
            </div>
          )}

          {tab === 'Activity' && (
            <ul className="tm-activity">
              {task.activity.map((a) => (
                <li key={a.id}>
                  <span className="tm-activity-type">{a.activityType}</span>
                  <span>{a.performedBy?.name || 'System'}</span>
                  {a.oldStatus && a.newStatus && <span className="tm-muted">{a.oldStatus} → {a.newStatus}</span>}
                  {a.notes && <span className="tm-muted">{a.notes}</span>}
                  <span className="tm-muted tm-activity-when">{fmtDateTime(a.createdAt)}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}

export default TaskDetail;
