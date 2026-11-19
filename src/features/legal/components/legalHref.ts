import type { Href } from 'expo-router';

import type { LegalDocKind } from '../constants';

/** In-app route of a legal document. Built from a fixed allowlist, never from user input. */
export const legalHref = (kind: LegalDocKind) => `/legal/${kind}` as Href;
