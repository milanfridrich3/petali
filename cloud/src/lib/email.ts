// The unique key of an account is the NORMALIZED email: trimmed, Unicode-compatibility-folded and lower-cased,
// so "  Ann@Example.com " and "ann@example.com" are the same account. The address as typed is kept for display.
export const normalizeEmail = (email: string): string => email.trim().normalize('NFKC').toLowerCase();
