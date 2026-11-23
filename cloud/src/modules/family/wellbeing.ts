import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { withTransaction } from '../../db/pool';
import { badRequest, conflict, forbidden, notFound } from '../../lib/errors';
import { audit, loadMember, loadMembership, loadSharing, requireMembership, type Client, type Db, type Membership } from './access';
import { dayKeys, resolveWindow } from './dashboard-core';
import { canManageMember, canViewMemberData, type Sharing } from './permissions';
import { LIMITS, dayCompliance, isRuleKind, validateConfig, type RuleConfig, type RuleKind } from './wellbeing-core';

// Digital Wellbeing, Stage 3: rules (limits, schedules, break reminders) of family members, proposals between members, delivery of a member's own active
// rules to their computers, and the compliance report built from what the computers synchronised.
//
// Principles:
//   * CONSENT: a member creates and changes their own rules directly. Another member (permission wellbeing.manage) can only PROPOSE: a new rule is
//     'pending' and a change of an active rule is stored aside (pending_config); neither reaches a computer until the member accepts. Nobody can
//     switch a rule on for somebody else, and nobody can read a member's usage through this module.
//   * Rules are only DELIVERED (myRules) from the signed-in account's own rows, status 'active'. Pending proposals are never delivered.
//   * The compliance report needs the member's consent (individualReports AND screenTime) exactly like the Stage 2 reports; the member always sees their own.
//   * Everything is decided from fresh rows inside the request; ids are looked up inside the caller's own family (a foreign id is "not found").
type RuleRow = {
  id: string; family_id: string; member_id: string; kind: string; config: unknown; status: string; proposed_by: string | null;
  pending_config: unknown; pending_by: string | null; version: number; created_at: Date; updated_at: Date;
};
const COLS = 'id, family_id, member_id, kind, config, status, proposed_by, pending_config, pending_by, version, created_at, updated_at';

export function createWellbeingService(deps: { pool: Pool; now?: () => number }) {
  const { pool } = deps;
  const now = deps.now ?? Date.now;
  const lock = (tx: PoolClient, key: string) => tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [key]);

  async function withFamilyTx<T>(userId: string, fn: (tx: PoolClient, m: Membership) => Promise<T>): Promise<T> {
    return withTransaction(pool, async (tx) => {
      const first = (await tx.query<{ family_id: string }>('SELECT family_id FROM family_members WHERE user_id = $1', [userId])).rows[0];
      if (!first) throw notFound('family_not_found', 'You are not in a family.');
      await lock(tx, `family:${first.family_id}`);
      const m = await loadMembership(tx, userId);
      if (!m || m.familyId !== first.family_id) throw notFound('family_not_found', 'You are not in a family.');
      return fn(tx, m);
    });
  }

  const ruleDto = (r: RuleRow, viewerUserId: string, subjectUserId: string) => ({
    id: r.id, memberId: r.member_id, kind: r.kind, config: r.config, status: r.status, version: r.version,
    origin: r.proposed_by === null ? 'self' : 'proposed', proposedByMe: r.proposed_by === viewerUserId,
    pendingChange: r.pending_config ? { config: r.pending_config, byMe: r.pending_by === viewerUserId } : null,
    awaitingMyAnswer: subjectUserId === viewerUserId && (r.status === 'pending' || r.pending_config !== null),
    createdAt: r.created_at.toISOString(), updatedAt: r.updated_at.toISOString(),
  });

  function parse(kind: unknown, raw: unknown): { kind: RuleKind; config: RuleConfig } {
    if (!isRuleKind(kind)) throw badRequest('invalid_rule_kind', 'kind must be limit, schedule or break.');
    const v = validateConfig(kind, raw);
    if (!v.ok) throw badRequest('invalid_rule', v.error);
    return { kind, config: v.config };
  }

  // The devices a rule may name must be computers of the SUBJECT (a rule cannot point at somebody else's computer).
  async function checkDevices(db: Db, subjectUserId: string, config: RuleConfig): Promise<void> {
    const ids = (config as { deviceIds?: string[] }).deviceIds ?? [];
    if (!ids.length) return;
    const r = await db.query<{ n: number }>('SELECT count(*)::int AS n FROM devices WHERE user_id = $1 AND revoked_at IS NULL AND id = ANY($2::uuid[])', [subjectUserId, ids]);
    if ((r.rows[0]?.n ?? 0) !== ids.length) throw badRequest('invalid_rule', 'A rule can only name computers of the member it is for.');
  }

  async function loadRule(db: Db, familyId: string, ruleId: string, forUpdate = false): Promise<{ rule: RuleRow; subjectUserId: string }> {
    const r = await db.query<RuleRow & { subject_user: string }>(
      `SELECT ${COLS.split(', ').map((c) => `w.${c}`).join(', ')}, m.user_id AS subject_user FROM family_wellbeing_rules w JOIN family_members m ON m.id = w.member_id
       WHERE w.id = $1 AND w.family_id = $2 ${forUpdate ? 'FOR UPDATE OF w' : ''}`, [ruleId, familyId]);
    const row = r.rows[0]; if (!row) throw notFound('rule_not_found', 'Rule not found.');
    return { rule: row, subjectUserId: row.subject_user };
  }

  async function countRules(db: Db, memberId: string, kind: RuleKind): Promise<number> {
    return (await db.query<{ n: number }>('SELECT count(*)::int AS n FROM family_wellbeing_rules WHERE member_id = $1 AND kind = $2', [memberId, kind])).rows[0]?.n ?? 0;
  }

  // ---- reading rules -----------------------------------------------------------------------------------------------------------------------
  // Own rules: everything (including proposals waiting for the answer). Another member's rules need wellbeing.manage and show only what a family
  // manager set or proposed; a member's purely personal rules stay private unless the member shares screen time.
  async function list(userId: string, memberId?: string) {
    const viewer = await requireMembership(pool, userId);
    const target = await loadMember(pool, viewer.familyId, memberId ?? viewer.memberId);
    const self = target.member_id === viewer.memberId;
    if (!self && !viewer.permissions.has('wellbeing.manage')) throw forbidden('permission_denied', 'You do not have permission to do this.');
    const rows = (await pool.query<RuleRow>(`SELECT ${COLS} FROM family_wellbeing_rules WHERE member_id = $1 ORDER BY kind, created_at, id`, [target.member_id])).rows;
    let visible = rows;
    if (!self) {
      const sh = (await loadSharing(pool, [target.member_id])).get(target.member_id) as Sharing;
      const sees = canViewMemberData(viewer, { memberId: target.member_id, familyId: target.family_id, sharing: sh }, 'screenTime').allowed;
      visible = rows.filter((r) => sees || r.proposed_by !== null || r.pending_by !== null);
    }
    return { member: { memberId: target.member_id, petaliId: target.petali_id, displayName: target.display_name, isSelf: self }, rules: visible.map((r) => ruleDto(r, userId, target.user_id)), limits: { maxLimitRules: LIMITS.maxLimitRules, maxScheduleRules: LIMITS.maxScheduleRules } };
  }

  // What the signed-in account's computers must evaluate. Only active rules of the caller, never proposals, never somebody else's rules.
  async function myRules(userId: string) {
    const m = await loadMembership(pool, userId);
    const serverTime = new Date(now()).toISOString();
    if (!m) return { inFamily: false, revision: 'none', serverTime, rules: [] as unknown[] };
    const rows = (await pool.query<RuleRow>(`SELECT ${COLS} FROM family_wellbeing_rules WHERE member_id = $1 AND status = 'active' ORDER BY kind, created_at, id`, [m.memberId])).rows;
    const revision = createHash('sha256').update(rows.map((r) => `${r.id}:${r.version}`).join('|')).digest('hex').slice(0, 16);
    return { inFamily: true, revision, serverTime, rules: rows.map((r) => ({ id: r.id, kind: r.kind, version: r.version, config: r.config })) };
  }

  // ---- changing rules -----------------------------------------------------------------------------------------------------------------------
  async function create(userId: string, memberId: string | null, body: { kind: unknown; config: unknown }, client: Client) {
    const { kind, config } = parse(body.kind, body.config);
    return withFamilyTx(userId, async (tx, viewer) => {
      const target = await loadMember(tx, viewer.familyId, memberId ?? viewer.memberId);
      const self = target.member_id === viewer.memberId;
      if (!self) {
        if (!viewer.permissions.has('wellbeing.manage')) throw forbidden('permission_denied', 'You do not have permission to do this.');
        const ok = canManageMember(viewer, { memberId: target.member_id, role: target.role, isOwner: target.is_owner });
        if (!ok.ok) throw forbidden(ok.code, ok.message);
      }
      await checkDevices(tx, target.user_id, config);
      const cap = kind === 'limit' ? LIMITS.maxLimitRules : kind === 'schedule' ? LIMITS.maxScheduleRules : 2;
      if ((await countRules(tx, target.member_id, kind)) >= cap) throw conflict('too_many_rules', 'There are already too many rules of this kind.');
      if (kind === 'break' && (await countRules(tx, target.member_id, 'break')) > 0) throw conflict('break_rule_exists', 'Break reminders already exist for this member; change them instead.');
      const r = await tx.query<RuleRow>(
        `INSERT INTO family_wellbeing_rules (family_id, member_id, kind, config, status, proposed_by) VALUES ($1,$2,$3,$4::jsonb,$5,$6) RETURNING ${COLS}`,
        [viewer.familyId, target.member_id, kind, JSON.stringify(config), self ? 'active' : 'pending', self ? null : userId]);
      const row = r.rows[0] as RuleRow;
      await audit(tx, viewer.familyId, self ? 'wellbeing.rule_created' : 'wellbeing.rule_proposed', userId, target.user_id, { ruleId: row.id, kind }, client, self ? 'actor' : 'family');
      return ruleDto(row, userId, target.user_id);
    });
  }

  async function update(userId: string, ruleId: string, rawConfig: unknown, client: Client) {
    return withFamilyTx(userId, async (tx, viewer) => {
      const { rule, subjectUserId } = await loadRule(tx, viewer.familyId, ruleId, true);
      const kind = rule.kind as RuleKind;
      const parsed = parse(kind, rawConfig);
      await checkDevices(tx, subjectUserId, parsed.config);
      const self = subjectUserId === userId;
      let row: RuleRow;
      if (self) {
        if (rule.status === 'pending') throw conflict('rule_pending', 'Answer the proposal first (accept or decline it).');
        row = (await tx.query<RuleRow>(`UPDATE family_wellbeing_rules SET config = $2::jsonb, pending_config = NULL, pending_by = NULL, version = version + 1 WHERE id = $1 RETURNING ${COLS}`, [ruleId, JSON.stringify(parsed.config)])).rows[0] as RuleRow;
        await audit(tx, viewer.familyId, 'wellbeing.rule_updated', userId, subjectUserId, { ruleId, kind }, client, 'actor');
      } else {
        if (!viewer.permissions.has('wellbeing.manage')) throw forbidden('permission_denied', 'You do not have permission to do this.');
        const target = await loadMember(tx, viewer.familyId, rule.member_id);
        const ok = canManageMember(viewer, { memberId: target.member_id, role: target.role, isOwner: target.is_owner });
        if (!ok.ok) throw forbidden(ok.code, ok.message);
        if (rule.status === 'pending') {
          if (rule.proposed_by !== userId) throw forbidden('permission_denied', 'Only the member who proposed this rule can change the proposal.');
          row = (await tx.query<RuleRow>(`UPDATE family_wellbeing_rules SET config = $2::jsonb WHERE id = $1 RETURNING ${COLS}`, [ruleId, JSON.stringify(parsed.config)])).rows[0] as RuleRow;
        } else {
          row = (await tx.query<RuleRow>(`UPDATE family_wellbeing_rules SET pending_config = $2::jsonb, pending_by = $3 WHERE id = $1 RETURNING ${COLS}`, [ruleId, JSON.stringify(parsed.config), userId])).rows[0] as RuleRow;
        }
        await audit(tx, viewer.familyId, 'wellbeing.change_proposed', userId, subjectUserId, { ruleId, kind }, client);
      }
      return ruleDto(row, userId, subjectUserId);
    });
  }

  // Only the member the rule is for can answer. Accepting a new proposal activates it; accepting a change replaces the active config.
  async function respond(userId: string, ruleId: string, accept: boolean, client: Client) {
    return withFamilyTx(userId, async (tx, viewer) => {
      const { rule, subjectUserId } = await loadRule(tx, viewer.familyId, ruleId, true);
      if (subjectUserId !== userId) throw forbidden('permission_denied', 'Only the member a rule is for can answer a proposal.');
      if (rule.status === 'pending') {
        if (!accept) {
          await tx.query('DELETE FROM family_wellbeing_rules WHERE id = $1', [ruleId]);
          await audit(tx, viewer.familyId, 'wellbeing.proposal_declined', userId, rule.proposed_by, { ruleId, kind: rule.kind }, client);
          return { id: ruleId, removed: true as const };
        }
        const row = (await tx.query<RuleRow>(`UPDATE family_wellbeing_rules SET status = 'active', version = version + 1 WHERE id = $1 RETURNING ${COLS}`, [ruleId])).rows[0] as RuleRow;
        await audit(tx, viewer.familyId, 'wellbeing.proposal_accepted', userId, rule.proposed_by, { ruleId, kind: rule.kind }, client);
        return ruleDto(row, userId, subjectUserId);
      }
      if (rule.pending_config === null) throw conflict('nothing_to_answer', 'There is no proposal to answer.');
      const sql = accept
        ? `UPDATE family_wellbeing_rules SET config = pending_config, pending_config = NULL, pending_by = NULL, version = version + 1 WHERE id = $1 RETURNING ${COLS}`
        : `UPDATE family_wellbeing_rules SET pending_config = NULL, pending_by = NULL WHERE id = $1 RETURNING ${COLS}`;
      const row = (await tx.query<RuleRow>(sql, [ruleId])).rows[0] as RuleRow;
      await audit(tx, viewer.familyId, accept ? 'wellbeing.change_accepted' : 'wellbeing.change_declined', userId, rule.pending_by, { ruleId, kind: rule.kind }, client);
      return ruleDto(row, userId, subjectUserId);
    });
  }

  // The member can remove any of their rules. A manager can withdraw their own pending proposal and remove a rule that a family member set for the
  // member (never the member's personal rules).
  async function remove(userId: string, ruleId: string, client: Client) {
    return withFamilyTx(userId, async (tx, viewer) => {
      const { rule, subjectUserId } = await loadRule(tx, viewer.familyId, ruleId, true);
      if (subjectUserId !== userId) {
        if (!viewer.permissions.has('wellbeing.manage')) throw forbidden('permission_denied', 'You do not have permission to do this.');
        const target = await loadMember(tx, viewer.familyId, rule.member_id);
        const ok = canManageMember(viewer, { memberId: target.member_id, role: target.role, isOwner: target.is_owner });
        if (!ok.ok) throw forbidden(ok.code, ok.message);
        if (rule.proposed_by === null) throw forbidden('rule_is_personal', 'This is the member\u2019s own rule; only the member can remove it.');
      }
      await tx.query('DELETE FROM family_wellbeing_rules WHERE id = $1', [ruleId]);
      await audit(tx, viewer.familyId, 'wellbeing.rule_removed', userId, subjectUserId, { ruleId, kind: rule.kind }, client, subjectUserId === userId && rule.proposed_by === null ? 'actor' : 'family');
      return { id: ruleId, removed: true as const };
    });
  }

  // ---- report ---------------------------------------------------------------------------------------------------------------------------------
  // Compliance and break statistics from the "wellbeing" documents the member's computers synchronised. Measured (what the computers recorded) is kept apart
  // from configured (the rules as they are now) and calculated (the summary). A day without a document is "no data", never "within the limit".
  async function report(userId: string, memberId: string, q: Record<string, unknown>) {
    const c = await pool.connect();
    try {
      await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const viewer = await requireMembership(c, userId);
      const target = await loadMember(c, viewer.familyId, memberId);
      const self = target.member_id === viewer.memberId;
      const sh = (await loadSharing(c, [target.member_id])).get(target.member_id) as Sharing;
      const dec = (cat: 'individualReports' | 'screenTime' | 'deviceInfo') => canViewMemberData(viewer, { memberId: target.member_id, familyId: target.family_id, sharing: sh }, cat);
      const reports = dec('individualReports'); const screen = dec('screenTime');
      const base = { member: { memberId: target.member_id, petaliId: target.petali_id, displayName: target.display_name, isSelf: self } };
      if (!reports.allowed || !screen.allowed) { await c.query('COMMIT'); return { ...base, state: 'restricted' as const, reason: (!reports.allowed ? reports : screen).reason }; }
      const w = resolveWindow(q, now());
      const dev = (await c.query<{ id: string; name: string | null }>(
        `SELECT d.id, d.name FROM devices d LEFT JOIN family_devices fd ON fd.device_id = d.id AND fd.family_id = $1
         WHERE d.user_id = $2 AND d.revoked_at IS NULL AND ($3::boolean OR fd.member_id = $4) ORDER BY d.created_at, d.id`, [viewer.familyId, target.user_id, self, target.member_id])).rows;
      if (!dev.length) { await c.query('COMMIT'); return { ...base, state: 'empty' as const, reason: self ? 'no_devices' : 'no_devices_shared' }; }
      type DayRow = NonNullable<ReturnType<typeof dayCompliance>>;
      const load = async (from: string, to: string) => {
        const docs = (await c.query<{ device_id: string; doc_key: string; data: unknown }>(
          `SELECT device_id, doc_key, data FROM sync_documents WHERE kind = 'wellbeing' AND NOT deleted AND device_id = ANY($1::uuid[]) AND doc_key >= $2 AND doc_key <= $3`, [dev.map((d) => d.id), from, to])).rows;
        const byDay = new Map<string, unknown[]>(); const byDevice = new Map<string, unknown[]>();
        for (const d of docs) { const a1 = byDay.get(d.doc_key) ?? []; a1.push(d.data); byDay.set(d.doc_key, a1); const a2 = byDevice.get(d.device_id) ?? []; a2.push(d.data); byDevice.set(d.device_id, a2); }
        const keys = dayKeys(from, to);
        const days = keys.map((k) => dayCompliance(k, byDay.get(k) ?? []) ?? { day: k, limits: null, exceeded: null, withinLimit: null, breaks: null, scheduleViolationMs: null });
        const have = days.filter((d): d is DayRow => d.limits !== null);
        const sum = (f: (d: DayRow) => number) => have.reduce((a, d) => a + f(d), 0);
        const evaluated = sum((d) => d.limits); const exceeded = sum((d) => d.exceeded);
        return {
          days, byDevice, keys: keys.length, have: have.length,
          calc: {
            daysWithData: have.length, limitsEvaluated: evaluated, limitsExceeded: exceeded, limitsWithinLimit: evaluated - exceeded,
            complianceRate: evaluated > 0 ? Math.round(((evaluated - exceeded) / evaluated) * 1000) / 10 : null,
            daysWithAnExceededLimit: have.filter((d) => d.exceeded > 0).length,
            breakReminders: sum((d) => d.breaks.reminders), breaksDismissed: sum((d) => d.breaks.dismissed), breaksTaken: sum((d) => d.breaks.taken),
            scheduleViolationMs: sum((d) => d.scheduleViolationMs),
          },
        };
      };
      const cur = await load(w.range.from, w.range.to);
      if (!cur.have) { await c.query('COMMIT'); return { ...base, state: 'empty' as const, reason: 'no_data', range: w.range }; }
      const prev = await load(w.previous.from, w.previous.to);
      const showDevices = self || dec('deviceInfo').allowed;
      const out = {
        ...base, state: 'ok' as const, range: w.range,
        measured: { daysWithData: cur.have, daysInRange: cur.keys, days: cur.days },
        calculated: cur.calc,
        // Compared only when BOTH periods have evaluated limits; otherwise it says why not (never a comparison against nothing).
        comparison: prev.have > 0 && prev.calc.limitsEvaluated > 0 && cur.calc.limitsEvaluated > 0
          ? { state: 'ok' as const, previous: { range: w.previous, ...prev.calc }, complianceRateChange: cur.calc.complianceRate !== null && prev.calc.complianceRate !== null ? Math.round((cur.calc.complianceRate - prev.calc.complianceRate) * 10) / 10 : null }
          : { state: 'unavailable' as const, reason: prev.have === 0 ? 'no_previous_data' : 'no_limits_to_compare', previousRange: w.previous },
        devices: showDevices ? dev.map((d) => { const per = cur.byDevice.get(d.id) ?? []; const dd = per.map((x) => dayCompliance('x', [x])).filter((x): x is DayRow => x !== null);
          return { deviceId: d.id, name: d.name, daysWithData: dd.length, limitsEvaluated: dd.reduce((a, x) => a + x.limits, 0), limitsExceeded: dd.reduce((a, x) => a + x.exceeded, 0) }; }) : null,
      };
      await c.query('COMMIT');
      return out;
    } catch (e) { try { await c.query('ROLLBACK'); } catch { /* keep the original error */ } throw e; } finally { c.release(); }
  }

  async function configured(userId: string, memberId: string) {   // the configured limits shown beside a report (rules, not measurements)
    return list(userId, memberId);
  }

  return { list, myRules, create, update, respond, remove, report, configured };
}
export type WellbeingService = ReturnType<typeof createWellbeingService>;
