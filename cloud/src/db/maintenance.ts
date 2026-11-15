import type { Pool } from 'pg';

// Housekeeping that keeps tables from growing without bound. Safe to run any time and from several servers at once.
export async function runMaintenance(pool: Pool): Promise<{ events: number; sessions: number; throttles: number }> {
  const events = await pool.query(`DELETE FROM security_events WHERE created_at < now() - interval '90 days'`);
  const sessions = await pool.query(`DELETE FROM sessions WHERE (revoked_at IS NOT NULL AND revoked_at < now() - interval '30 days') OR (LEAST(expires_at, max_expires_at) < now() - interval '30 days')`);
  const throttles = await pool.query(`DELETE FROM login_throttle WHERE updated_at < now() - interval '1 day' AND (locked_until IS NULL OR locked_until < now())`);
  return { events: events.rowCount ?? 0, sessions: sessions.rowCount ?? 0, throttles: throttles.rowCount ?? 0 };
}
