/**
 * The schema, and the types derived from it.
 *
 * Architecture spec § 2.1 splits this across enums/providers/households/compliance/
 * portal/intake/auth/audit. That split is a pure reorganisation of declarations and is
 * deliberately NOT done in the same change as the move into this package — § 5 is
 * explicit that a refactor which also rearranges things is unreviewable. It is a
 * mechanical follow-up.
 */
export * from './schema';
