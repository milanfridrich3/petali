// The ONE place that defines what a family member may do. Nothing else in the code compares a role name to decide access:
// every check goes through effectivePermissions() / canManageMember() / canViewMemberData() below.
//
// Three independent layers decide access to something that belongs to another member:
//   1. the viewer's PERMISSION (role default, adjusted by explicit grants / denials stored per member),
//   2. the owner's CONSENT (the member's own sharing preference for that category; private by default),
//   3. membership of the SAME family (every lookup is scoped by the viewer's family id on the server).
// A parent is therefore NOT "an administrator of everything": without the child's consent a parent cannot read the child's usage data.

export const PERMISSIONS = [
  'family.view',                 // see the family itself (name, size, own role)
  'family.settings.update',      // rename the family, change family settings
  'members.view',                // see the list of members (name, Petali ID, role)
  'members.invite',              // send invitations
  'members.remove',              // remove members
  'members.roles.change',        // change roles and transfer nothing else (ownership is the owner's alone)
  'members.permissions.manage',  // grant / deny individual permissions
  'invitations.view',            // see pending invitations and their history
  'invitations.manage',          // revoke / resend invitations
  'devices.view',                // see which member owns which family device
  'devices.unlink',              // take another member's device out of the family view (never deletes or takes the device)
  'memberData.view',             // read another member's SHARED data (still needs that member's consent per category)
  'audit.view',                  // read the family's audit trail
  'wellbeing.manage',            // propose Digital Wellbeing rules (limits, schedules, breaks) to another member; the member decides (Stage 3)
] as const;
export type Permission = (typeof PERMISSIONS)[number];
export const isPermission = (v: unknown): v is Permission => typeof v === 'string' && (PERMISSIONS as readonly string[]).includes(v);

export type RoleDefinition = {
  label: string;
  // Administrators can own a family and are the only role the database lets be the owner. Adding a role later = adding an entry here
  // (and, if it should be an administrator, nothing else): no migration is needed, the database only checks the name's shape.
  administrator: boolean;
  permissions: readonly Permission[];
};

export const ROLES: Readonly<Record<string, RoleDefinition>> = {
  parent: { label: 'Parent', administrator: true, permissions: PERMISSIONS },
  child: { label: 'Child', administrator: false, permissions: ['family.view', 'members.view'] },
};
export const ROLE_NAMES = Object.keys(ROLES);
export const isRole = (v: unknown): v is string => typeof v === 'string' && Object.prototype.hasOwnProperty.call(ROLES, v);
export const isAdministratorRole = (role: string): boolean => ROLES[role]?.administrator === true;

// Permissions that can never be given to a role that is not an administrator, however the owner configures it.
export const NON_DELEGABLE: readonly Permission[] = ['family.settings.update', 'members.remove', 'members.roles.change', 'members.permissions.manage', 'audit.view', 'wellbeing.manage'];
// Permissions nobody can take away (everyone in a family may look at the family they are in).
export const ALWAYS_GRANTED: readonly Permission[] = ['family.view'];

export type Overrides = { grant: readonly Permission[]; deny: readonly Permission[] };
export const NO_OVERRIDES: Overrides = { grant: [], deny: [] };

export function roleDefaults(role: string): Set<Permission> { return new Set(ROLES[role]?.permissions ?? []); }

// The owner always holds everything: it cannot be restricted, so a family cannot lock its own owner out.
export function effectivePermissions(input: { role: string; isOwner: boolean; overrides?: Overrides }): Set<Permission> {
  if (input.isOwner) return new Set(PERMISSIONS);
  const out = roleDefaults(input.role);
  const admin = isAdministratorRole(input.role);
  const o = input.overrides ?? NO_OVERRIDES;
  for (const p of o.grant) if (admin || !NON_DELEGABLE.includes(p)) out.add(p);
  for (const p of o.deny) if (!ALWAYS_GRANTED.includes(p)) out.delete(p);
  return out;
}

export type Actor = { memberId: string; role: string; isOwner: boolean; permissions: ReadonlySet<Permission> };
export type Target = { memberId: string; role: string; isOwner: boolean };

// May the actor change / remove the target (role, permissions, membership, device link)? The permission itself is checked separately.
//   * never yourself (leaving and changing your own sharing have their own operations),
//   * never the owner,
//   * an administrator target can only be managed by the owner (no coup between parents).
export function canManageMember(actor: Actor, target: Target): { ok: true } | { ok: false; code: string; message: string } {
  if (actor.memberId === target.memberId) return { ok: false, code: 'cannot_manage_self', message: 'This operation cannot be applied to yourself.' };
  if (target.isOwner) return { ok: false, code: 'owner_protected', message: 'The family owner cannot be changed this way.' };
  if (isAdministratorRole(target.role) && !actor.isOwner) return { ok: false, code: 'owner_required', message: 'Only the family owner can manage another parent.' };
  return { ok: true };
}

// ---- individual sharing (privacy) ------------------------------------------------------------------------------------------------
// The categories Stage 2 / 3 will read. Stage 1 only stores the member's choice and answers "may this viewer see that category of that member?".
export const PRIVACY_CATEGORIES = ['screenTime', 'appUsage', 'appCategories', 'usageHistory', 'deviceInfo', 'deviceHealth', 'individualReports'] as const;
export type PrivacyCategory = (typeof PRIVACY_CATEGORIES)[number];
export type Sharing = Record<PrivacyCategory, boolean>;
export const PRIVATE_BY_DEFAULT: Readonly<Sharing> = Object.freeze({ screenTime: false, appUsage: false, appCategories: false, usageHistory: false, deviceInfo: false, deviceHealth: false, individualReports: false });

// Stored JSON is untrusted too: unknown keys are dropped, anything that is not literally true counts as "not shared".
export function normalizeSharing(raw: unknown): Sharing {
  const out: Sharing = { ...PRIVATE_BY_DEFAULT };
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) for (const c of PRIVACY_CATEGORIES) if ((raw as Record<string, unknown>)[c] === true) out[c] = true;
  return out;
}

export type AccessDecision = { allowed: boolean; reason: 'self' | 'shared' | 'not_shared' | 'no_permission' | 'other_family' };

// The single decision function for "may `viewer` read `category` data of `target`?". Stage 2 and 3 must call this and nothing else.
export function canViewMemberData(viewer: { memberId: string; familyId: string; permissions: ReadonlySet<Permission> }, target: { memberId: string; familyId: string; sharing: Sharing }, category: PrivacyCategory): AccessDecision {
  if (viewer.familyId !== target.familyId) return { allowed: false, reason: 'other_family' };
  if (viewer.memberId === target.memberId) return { allowed: true, reason: 'self' };
  if (!viewer.permissions.has('memberData.view')) return { allowed: false, reason: 'no_permission' };
  return target.sharing[category] === true ? { allowed: true, reason: 'shared' } : { allowed: false, reason: 'not_shared' };
}

// ---- family settings ------------------------------------------------------------------------------------------------------------
export type FamilySettings = { childrenCanLeave: boolean };
export const DEFAULT_FAMILY_SETTINGS: Readonly<FamilySettings> = Object.freeze({ childrenCanLeave: true });
export function normalizeSettings(raw: unknown): FamilySettings {
  const out: FamilySettings = { ...DEFAULT_FAMILY_SETTINGS };
  if (raw && typeof raw === 'object' && !Array.isArray(raw) && typeof (raw as Record<string, unknown>)['childrenCanLeave'] === 'boolean') out.childrenCanLeave = (raw as Record<string, boolean>)['childrenCanLeave'] as boolean;
  return out;
}
