// What the API shows about an account. The internal UUID of a user is never part of any response: clients identify
// an account by its Petali ID, and the server identifies the caller only by the verified access token.
export type UserRow = {
  id: string; petali_id: string; email: string; email_normalized: string; password_hash: string; display_name: string | null;
  email_verified_at: Date | null; email_changed_at: Date | null; password_changed_at: Date; password_usable?: boolean; deletion_requested_at: Date | null;
  created_at: Date; updated_at: Date;
};

export type UserDto = {
  petaliId: string; email: string; emailVerified: boolean; displayName: string | null;
  createdAt: string; updatedAt: string; passwordChangedAt: string; deletionRequestedAt: string | null;
  hasPassword: boolean;     // false for an account created through Google that has no password (Phase 7); additive, existing clients ignore it
};

export const toUserDto = (u: UserRow): UserDto => ({
  petaliId: u.petali_id,
  email: u.email,
  emailVerified: u.email_verified_at !== null,
  displayName: u.display_name,
  createdAt: u.created_at.toISOString(),
  updatedAt: u.updated_at.toISOString(),
  passwordChangedAt: u.password_changed_at.toISOString(),
  deletionRequestedAt: u.deletion_requested_at ? u.deletion_requested_at.toISOString() : null,
  hasPassword: u.password_usable !== false,
});

export type SessionRow = {
  id: string; user_id: string; device_label: string | null; user_agent: string | null; ip_address: string | null;
  created_at: Date; last_used_at: Date; expires_at: Date; max_expires_at: Date; revoked_at: Date | null;
};

export const toSessionDto = (s: SessionRow, currentSessionId: string) => ({
  id: s.id,
  current: s.id === currentSessionId,
  deviceLabel: s.device_label,
  ipAddress: s.ip_address,
  createdAt: s.created_at.toISOString(),
  lastUsedAt: s.last_used_at.toISOString(),
  expiresAt: (s.expires_at < s.max_expires_at ? s.expires_at : s.max_expires_at).toISOString(),
});
