/**
 * Facts the legal texts and the consent screens rely on. Pure TypeScript, no
 * react-native imports: the web page generator (scripts/generate-legal-pages.mjs)
 * loads this file in plain Node.
 *
 * No personal details belong here. The controller's name, address and e-mail
 * come only from the environment (see config.ts).
 */

/** Shown wherever a controller detail has not been configured. */
export const PLACEHOLDER = '[TO BE FILLED]';

/**
 * Flip to true only after a lawyer has reviewed both documents. While false,
 * every rendering of the Terms and the Privacy Notice carries a visible
 * "draft" banner.
 */
export const LEGAL_REVIEWED = false;

export const DRAFT_BANNER_TEXT = 'Draft — to be reviewed by a lawyer before launch';

/**
 * Versions of the bundled texts. They must match `legal_documents` on the server (seeded as '1'):
 * version '2' (About you: birth year, gender, emergency contact, T-shirt size) is published on the
 * server with `select public.admin_set_legal_version('terms','2'), public.admin_set_legal_version('privacy','2');`
 * when the new app build is in use, which makes every member accept the updated texts.
 */
export const TERMS_VERSION = '2';
export const PRIVACY_VERSION = '2';

/** When the bundled texts were last changed (shown in the documents). */
export const LEGAL_LAST_UPDATED = '2026-11-23';

/** The combined string the server stores for `terms_privacy`: `terms:<v>|privacy:<v>`. */
export const BUNDLED_TERMS_PRIVACY_VERSION = `terms:${TERMS_VERSION}|privacy:${PRIVACY_VERSION}`;

/** Nobody under this age may use TrainHive. */
export const MINIMUM_AGE = 16;

/** Romanian supervisory authority (complaints, Art. 77 GDPR). */
export const SUPERVISORY_AUTHORITY = {
  name: 'ANSPDCP (Autoritatea Nationala de Supraveghere a Prelucrarii Datelor cu Caracter Personal), Romania',
  shortName: 'ANSPDCP',
  website: 'https://www.dataprotection.ro',
} as const;

/** Retention periods stated in the Privacy Notice (they mirror what the server enforces). */
export const RETENTION = {
  readNotificationsDays: 90,
  unreadNotificationsDays: 180,
  failedAttemptsHours: 24,
} as const;

/** Third parties that process data for TrainHive. */
export const PROCESSORS = {
  database: 'Supabase',
  push: ['Expo (push notification service)', 'Google Firebase Cloud Messaging'],
} as const;

export type LegalDocKind = 'terms' | 'privacy';

export const LEGAL_DOC_KINDS: readonly LegalDocKind[] = ['privacy', 'terms'];

/** Parses a route parameter; anything else is not a document. */
export function parseLegalDocKind(value: unknown): LegalDocKind | null {
  return value === 'terms' || value === 'privacy' ? value : null;
}

export const LEGAL_DOC_TITLES: Record<LegalDocKind, string> = {
  terms: 'Terms of Use',
  privacy: 'Privacy Notice',
};

/**
 * Features that collect or show personal data and ship in later phases. The
 * legal texts and the Privacy settings describe a feature ONLY when its flag
 * is true, so a text never promises something the system does not do. Flip a
 * flag in the same change that ships the feature.
 */
export type LegalFeatures = {
  /** Birth year and gender, with grouped statistics (groups of 5 or more). */
  demographics: boolean;
  /** Emergency contact and T-shirt size. */
  emergencyContact: boolean;
  /** Workout logs and group totals. */
  workoutLogs: boolean;
  /** Replies and posts in event discussions. */
  eventPosts: boolean;
};

export const FEATURES: LegalFeatures = {
  demographics: true,
  emergencyContact: true,
  workoutLogs: false,
  eventPosts: false,
};
