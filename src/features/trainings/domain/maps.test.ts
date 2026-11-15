import { describe, expect, it } from 'vitest';

import {
  buildMapsLink,
  isSafeMapUrl,
  locationSearchText,
  type MapsPlatform,
} from '@/features/trainings/domain/maps';

const PLATFORMS: MapsPlatform[] = ['ios', 'android', 'web'];

function location(overrides: Partial<Parameters<typeof buildMapsLink>[0]> = {}) {
  return {
    location_name: 'Herastrau Park',
    address: null,
    latitude: null,
    longitude: null,
    map_url: null,
    ...overrides,
  };
}

describe('buildMapsLink', () => {
  it('prefers the organizer map link on every platform', () => {
    const withAll = location({
      map_url: ' https://maps.app.goo.gl/abc123 ',
      latitude: 44.47,
      longitude: 26.08,
      address: 'Sos. Nordului 7-9',
    });
    for (const platform of PLATFORMS) {
      expect(buildMapsLink(withAll, platform)).toEqual({
        url: 'https://maps.app.goo.gl/abc123',
        fallbackUrl: 'https://maps.app.goo.gl/abc123',
        source: 'map_url',
      });
    }
  });

  it('never opens a stored link that is not http(s)', () => {
    for (const bad of ['javascript:alert(1)', 'intent://evil#Intent;end', 'file:///etc/passwd', 'maps.google.com', '']) {
      const link = buildMapsLink(location({ map_url: bad }), 'android');
      expect(link.source).toBe('search');
      expect(link.url.startsWith('geo:0,0?q=')).toBe(true);
    }
  });

  it('uses coordinates when there is no link', () => {
    const point = location({ latitude: 44.4702, longitude: 26.0823 });
    expect(buildMapsLink(point, 'ios')).toEqual({
      url: 'https://maps.apple.com/?ll=44.4702,26.0823&q=Herastrau%20Park',
      fallbackUrl: 'https://www.google.com/maps/search/?api=1&query=44.4702%2C26.0823',
      source: 'coordinates',
    });
    expect(buildMapsLink(point, 'android')).toEqual({
      url: 'geo:44.4702,26.0823?q=44.4702,26.0823(Herastrau%20Park)',
      fallbackUrl: 'https://www.google.com/maps/search/?api=1&query=44.4702%2C26.0823',
      source: 'coordinates',
    });
    expect(buildMapsLink(point, 'web').url).toBe(
      'https://www.google.com/maps/search/?api=1&query=44.4702%2C26.0823',
    );
  });

  it('handles negative and zero coordinates', () => {
    expect(buildMapsLink(location({ latitude: -33.86, longitude: 151.21 }), 'android').url).toBe(
      'geo:-33.86,151.21?q=-33.86,151.21(Herastrau%20Park)',
    );
    expect(buildMapsLink(location({ latitude: 0, longitude: 0 }), 'web').source).toBe('coordinates');
  });

  it('ignores half or out-of-range coordinates', () => {
    expect(buildMapsLink(location({ latitude: 44.47 }), 'web').source).toBe('search');
    expect(buildMapsLink(location({ longitude: 26.08 }), 'web').source).toBe('search');
    expect(buildMapsLink(location({ latitude: 95, longitude: 26 }), 'web').source).toBe('search');
    expect(buildMapsLink(location({ latitude: 44, longitude: 190 }), 'web').source).toBe('search');
    expect(buildMapsLink(location({ latitude: Number.NaN, longitude: 26 }), 'web').source).toBe(
      'search',
    );
  });

  it('falls back to searching for the name and address', () => {
    const named = location({ address: 'Sos. Nordului 7-9, București' });
    const query = encodeURIComponent('Herastrau Park, Sos. Nordului 7-9, București');
    expect(buildMapsLink(named, 'ios').url).toBe(`https://maps.apple.com/?q=${query}`);
    expect(buildMapsLink(named, 'android').url).toBe(`geo:0,0?q=${query}`);
    expect(buildMapsLink(named, 'web').url).toBe(
      `https://www.google.com/maps/search/?api=1&query=${query}`,
    );
  });

  it('always produces a link from the name alone', () => {
    for (const platform of PLATFORMS) {
      const link = buildMapsLink(location(), platform);
      expect(link.source).toBe('search');
      expect(link.url).toContain('Herastrau%20Park');
    }
  });

  it('escapes characters that would break or extend the URL', () => {
    const tricky = location({ location_name: 'Gym & Co #2 ?x=1', address: 'a/b' });
    for (const platform of PLATFORMS) {
      const { url } = buildMapsLink(tricky, platform);
      expect(url).toContain('Gym%20%26%20Co%20%232%20%3Fx%3D1');
      expect(url).not.toContain(' ');
      expect(url).not.toContain('#');
    }
  });

  it('always has an https fallback', () => {
    const cases = [
      location(),
      location({ latitude: 44.47, longitude: 26.08 }),
      location({ map_url: 'http://example.com/map' }),
    ];
    for (const item of cases) {
      for (const platform of PLATFORMS) {
        expect(buildMapsLink(item, platform).fallbackUrl).toMatch(/^https?:\/\//);
      }
    }
  });
});

describe('helpers', () => {
  it('isSafeMapUrl accepts only http(s)', () => {
    expect(isSafeMapUrl('https://example.com')).toBe(true);
    expect(isSafeMapUrl('HTTP://example.com/x')).toBe(true);
    expect(isSafeMapUrl('geo:1,2')).toBe(false);
    expect(isSafeMapUrl('https://')).toBe(false);
    expect(isSafeMapUrl(null)).toBe(false);
    expect(isSafeMapUrl(undefined)).toBe(false);
  });

  it('locationSearchText joins the filled parts', () => {
    expect(locationSearchText({ location_name: ' Park ', address: ' Street 1 ' })).toBe(
      'Park, Street 1',
    );
    expect(locationSearchText({ location_name: 'Park', address: null })).toBe('Park');
    expect(locationSearchText({ location_name: 'Park', address: '  ' })).toBe('Park');
  });
});
