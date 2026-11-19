import type { LegalConfig } from '../config';
import type { LegalDocKind } from '../constants';
import { buildPrivacyNotice } from './privacy';
import { buildTerms } from './terms';
import type { LegalDocument } from './types';

export type { LegalBlock, LegalDocument, LegalSection } from './types';

export function buildLegalDocument(kind: LegalDocKind, config: LegalConfig): LegalDocument {
  return kind === 'terms' ? buildTerms(config) : buildPrivacyNotice(config);
}
