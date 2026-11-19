import type { LegalConfig } from '../config';
import { FEATURES, type LegalDocKind, type LegalFeatures } from '../constants';
import { buildPrivacyNotice } from './privacy';
import { buildTerms } from './terms';
import type { LegalDocument } from './types';

export type { LegalBlock, LegalDocument, LegalSection } from './types';

/** `features` defaults to the shipped state; tests pass explicit flags. */
export function buildLegalDocument(
  kind: LegalDocKind,
  config: LegalConfig,
  features: LegalFeatures = FEATURES,
): LegalDocument {
  return kind === 'terms' ? buildTerms(config, features) : buildPrivacyNotice(config, features);
}
