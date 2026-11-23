import type { Pool } from 'pg';

// Housekeeping that keeps tables from growing without bound. Safe to run any time and from several servers at once.
export async function runMaintenance(pool: Pool): Promise<{ events: number; sessions: number; throttles: number; family: number }> {
  const events = await pool.query(`DELETE FROM security_events WHERE created_at < now() - interval '90 days'`);
  const sessions = await pool.query(`DELETE FROM sessions WHERE (revoked_at IS NOT NULL AND revoked_at < now() - interval '30 days') OR (LEAST(expires_at, max_expires_at) < now() - interval '30 days')`);
  const throttles = await pool.query(`DELETE FROM login_throttle WHERE updated_at < now() - interval '1 day' AND (locked_until IS NULL OR locked_until < now())`);
  // Petali Family housekeeping: stale open invitations / hand-overs are closed as expired, finished ones are dropped after 90 days, the audit trail after 400 days.
  const fam = (await pool.query(`UPDATE family_invitations SET status = 'expired', responded_at = now() WHERE status = 'pending' AND expires_at < now()`)).rowCount ?? 0;
  const tr = (await pool.query(`UPDATE family_device_transfers SET status = 'expired', responded_at = now() WHERE status = 'pending' AND expires_at < now()`)).rowCount ?? 0;
  const oldInv = (await pool.query(`DELETE FROM family_invitations WHERE status <> 'pending' AND responded_at < now() - interval '90 days'`)).rowCount ?? 0;
  const oldTr = (await pool.query(`DELETE FROM family_device_transfers WHERE status <> 'pending' AND responded_at < now() - interval '90 days'`)).rowCount ?? 0;
  const oldAudit = (await pool.query(`DELETE FROM family_audit_log WHERE created_at < now() - interval '400 days'`)).rowCount ?? 0;
  return { family: fam + tr + oldInv + oldTr + oldAudit, events: events.rowCount ?? 0, sessions: sessions.rowCount ?? 0, throttles: throttles.rowCount ?? 0 };
}
