/**
 * QA (M1-Q1 part 2): "Open in maps" links built from organizer-entered text.
 * Defects are `it.fails` tagged `DEFECT Q2-n`.
 */
import { describe, expect, it } from 'vitest';

import { buildMapsLink, isSafeMapUrl } from '@/features/trainings/domain/maps';

const base = {
  location_name: 'Park',
  address: null,
  latitude: 44.4268,
  longitude: 26.1025,
  map_url: null,
};

describe('Android geo: label', () => {
  // DEFECT Q2-9: geo:LAT,LNG?q=LAT,LNG(LABEL) ends the label at the first closing parenthesis.
  // encodeURIComponent leaves ( and ) alone, so a place called "Parc Carol (poarta nord)" produces
  // a label that Android maps apps cut short or reject. Parentheses must be percent-encoded
  // (%28 / %29) inside the label.
  it('percent-encodes parentheses inside the label (was DEFECT Q2-9)', () => {
    const { url } = buildMapsLink({ ...base, location_name: 'Parc Carol (poarta nord)' }, 'android');
    const label = url.slice(url.indexOf('(') + 1, url.lastIndexOf(')'));
    expect(label).not.toMatch(/[()]/);
  });

  it('a plain name keeps a single label group', () => {
    const { url } = buildMapsLink({ ...base, location_name: 'Parc Carol' }, 'android');
    expect(url).toBe('geo:44.4268,26.1025?q=44.4268,26.1025(Parc%20Carol)');
  });
});

describe('what is opened', () => {
  it.each(['javascript:alert(1)', 'intent://x#Intent;scheme=http;end', 'file:///etc/passwd', 'http://', 'https:// space', '//evil.example', 'ftp://x.example'])(
    'never opens %j from map_url',
    (map_url) => {
      expect(isSafeMapUrl(map_url)).toBe(false);
      for (const platform of ['android', 'ios', 'web'] as const) {
        expect(buildMapsLink({ ...base, map_url }, platform).source).not.toBe('map_url');
      }
    },
  );

  it('survives a hostile location name without producing a second URL', () => {
    const name = 'Park&q=evil#frag?x=1';
    const web = buildMapsLink({ ...base, latitude: null, longitude: null, location_name: name }, 'web');
    expect(new URL(web.url).searchParams.get('query')).toBe(name);
    expect(new URL(web.url).hash).toBe('');
  });
});
