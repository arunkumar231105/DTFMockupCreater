// Approval gates. Only a human decides: staff in Design Studio (Design Jobs page),
// or a system holding the separate "approve" scope that passes the name of the
// person who clicked. No AI tool (MCP / WebMCP) can decide an approval.
//
//   mockup     agent_review → customer   (customer can only be recorded after an agent approved)
//   artwork    artwork_review            (background removed — a human checks nothing needed was lost)
//   gangsheet  qa                        (the full-resolution print file exists only after this)
import { ApiError, bad } from './common.js';
import { q, one, newId } from './db.js';

export const STAGES = { mockup: ['agent_review', 'customer'], artwork: ['artwork_review'], gangsheet: ['qa'] };

export async function createApproval({ subjectType, subjectId, stage, orderId }) {
  await q(`INSERT INTO api_approvals (id, subject_type, subject_id, stage, order_id) VALUES ($1,$2,$3,$4,$5)
           ON CONFLICT (subject_type, subject_id, stage) DO NOTHING`, [newId('AP'), subjectType, subjectId, stage, orderId || null]);
}

export const approvalView = (a) => ({
  approval_id: a.id, subject_type: a.subject_type, subject_id: a.subject_id, stage: a.stage, status: a.status,
  order_id: a.order_id, decided_by: a.decided_by, decided_via: a.decided_via, notes: a.notes,
  created_at: a.created_at, decided_at: a.decided_at,
});

export async function approvalsFor(subjectType, subjectId) {
  const { rows } = await q('SELECT * FROM api_approvals WHERE subject_type = $1 AND subject_id = $2', [subjectType, subjectId]);
  const out = {};
  for (const stage of STAGES[subjectType]) {
    const a = rows.find(r => r.stage === stage);
    const notYet = subjectType === 'mockup' && stage === 'customer' ? 'waiting_for_agent_review' : 'not_required';
    out[stage] = a ? { approval_id: a.id, status: a.status, decided_by: a.decided_by, decided_at: a.decided_at, notes: a.notes } : { status: notYet };
  }
  return out;
}

export const statusOf = async (subjectType, subjectId, stage) =>
  (await one('SELECT status FROM api_approvals WHERE subject_type = $1 AND subject_id = $2 AND stage = $3', [subjectType, subjectId, stage]))?.status || null;

/**
 * Human decision. ctx must be a staff session or an app with the approve scope.
 * body: { decision: approved|rejected, decided_by, notes, override_unapproved_items }
 */
export async function decide(ctx, approvalId, body) {
  const a = await one('SELECT * FROM api_approvals WHERE id = $1', [approvalId]);
  if (!a) throw new ApiError(404, 'unknown_approval', `Approval ${approvalId} not found.`);
  if (!ctx.isStaff) {
    const owner = a.subject_type === 'artwork'
      ? await one('SELECT app_id FROM api_artworks WHERE id = $1', [a.subject_id])
      : await one('SELECT app_id FROM api_jobs WHERE id = $1', [a.subject_id]);
    if (!owner || Number(owner.app_id) !== ctx.appId) throw new ApiError(404, 'unknown_approval', `Approval ${approvalId} not found.`);
  }
  const decision = String(body.decision || '').toLowerCase();
  if (!['approved', 'rejected'].includes(decision)) throw bad('decision must be "approved" or "rejected".');
  const decidedBy = ctx.isStaff ? ctx.userName : String(body.decided_by || '').trim().slice(0, 120);
  if (!decidedBy) throw bad('decided_by is required: the name of the person who made this decision.');
  const notes = body.notes ? String(body.notes).slice(0, 2000) : null;
  if (a.status !== 'pending') throw new ApiError(409, 'already_decided', `This approval was already ${a.status} by ${a.decided_by} at ${a.decided_at?.toISOString?.() || a.decided_at}.`);

  if (a.subject_type === 'mockup' && a.stage === 'customer') {
    const agent = await statusOf('mockup', a.subject_id, 'agent_review');
    if (agent !== 'approved') throw new ApiError(409, 'agent_review_required', 'A mockup must be approved by an agent before the customer decision is recorded.');
  }
  if (a.subject_type === 'gangsheet' && decision === 'approved') {
    const problems = await gangsheetItemProblems(a.subject_id);
    const blocking = problems.filter(p => p.blocking);
    if (blocking.length) throw new ApiError(409, 'items_not_releasable', 'Some artwork on this sheet was rejected or is still under review.', { items: blocking });
    if (problems.length && !body.override_unapproved_items) {
      throw new ApiError(409, 'items_not_customer_approved', 'Some items do not come from a customer-approved mockup. Approve with override_unapproved_items=true and a note if QA accepts them.', { items: problems });
    }
    if (problems.length && !notes) throw bad('A note is required when overriding unapproved items.');
  }

  await q(`UPDATE api_approvals SET status = $2, decided_by = $3, decided_via = $4, decided_app_id = $5, decided_user_id = $6, notes = $7, decided_at = NOW()
           WHERE id = $1`, [a.id, decision, decidedBy, ctx.isStaff ? 'studio' : 'api', ctx.appId, ctx.userId, notes]);
  if (a.subject_type === 'artwork') await q('UPDATE api_artworks SET review_status = $2 WHERE id = $1', [a.subject_id, decision]);
  if (a.subject_type === 'mockup' && a.stage === 'agent_review' && decision === 'approved') {
    const job = await one('SELECT order_id FROM api_jobs WHERE id = $1', [a.subject_id]);
    await createApproval({ subjectType: 'mockup', subjectId: a.subject_id, stage: 'customer', orderId: job?.order_id });
  }
  return approvalView(await one('SELECT * FROM api_approvals WHERE id = $1', [a.id]));
}

/** Items on a gang sheet that are not cleared for production. */
export async function gangsheetItemProblems(jobId) {
  const job = await one('SELECT input FROM api_jobs WHERE id = $1', [jobId]);
  const problems = [];
  for (const [i, it] of (job?.input?.items || []).entries()) {
    const art = await one('SELECT id, review_status FROM api_artworks WHERE id = $1', [it.artwork_id]);
    if (art && ['pending_review', 'rejected'].includes(art.review_status)) {
      problems.push({ item: i, artwork_id: it.artwork_id, blocking: true, reason: `artwork review is ${art.review_status}` });
      continue;
    }
    if (it.mockup_job_id) {
      const c = await statusOf('mockup', it.mockup_job_id, 'customer');
      if (c === 'rejected') problems.push({ item: i, mockup_job_id: it.mockup_job_id, blocking: true, reason: 'customer rejected the mockup' });
      else if (c !== 'approved') problems.push({ item: i, mockup_job_id: it.mockup_job_id, blocking: false, reason: `customer approval is ${c || 'not recorded'}` });
    } else {
      problems.push({ item: i, artwork_id: it.artwork_id, blocking: false, reason: 'not linked to a customer-approved mockup' });
    }
  }
  return problems;
}

export async function listApprovals(ctx, { status = 'pending', order_id, limit = 100 } = {}) {
  const params = [status];
  let where = 'a.status = $1';
  if (order_id) { params.push(order_id); where += ` AND a.order_id = $${params.length}`; }
  if (!ctx.isStaff) {
    params.push(ctx.appId);
    where += ` AND COALESCE((SELECT app_id FROM api_jobs j WHERE j.id = a.subject_id), (SELECT app_id FROM api_artworks r WHERE r.id = a.subject_id)) = $${params.length}`;
  }
  const total = (await one(`SELECT COUNT(*)::int AS n FROM api_approvals a WHERE ${where}`, params)).n;
  params.push(Math.min(Number(limit) || 100, 500));
  const { rows } = await q(`SELECT a.* FROM api_approvals a WHERE ${where} ORDER BY a.created_at LIMIT $${params.length}`, params);
  return { approvals: rows.map(approvalView), total };
}
