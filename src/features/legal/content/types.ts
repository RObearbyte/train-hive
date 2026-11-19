/** Structured legal content: rendered natively by the app and as HTML by the web generator. */

export type LegalBlock =
  | { type: 'paragraph'; text: string }
  | { type: 'list'; items: readonly string[] }
  /** A small table-like list: one row per label / value pair (the data inventory). */
  | { type: 'facts'; rows: readonly { label: string; value: string }[] };

export type LegalSection = {
  /** Stable id for anchors. */
  id: string;
  heading: string;
  blocks: readonly LegalBlock[];
};

export type LegalDocument = {
  kind: 'terms' | 'privacy';
  title: string;
  version: string;
  /** ISO date (YYYY-MM-DD). */
  lastUpdated: string;
  /** Short summary shown under the title. */
  intro: string;
  sections: readonly LegalSection[];
};
