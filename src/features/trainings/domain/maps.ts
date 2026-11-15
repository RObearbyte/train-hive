/**
 * Builds the link behind "Open in maps". Pure: the platform is passed in.
 *
 * Order of preference: the organizer's own `map_url`, then coordinates, then
 * a text search for the location name and address. `fallbackUrl` is always an
 * https link, for devices where the native scheme has no handler.
 */
import type { TrainingSession } from '@/lib/database.types';

export type MapsPlatform = 'ios' | 'android' | 'web';

export type MapsLink = {
  url: string;
  fallbackUrl: string;
  source: 'map_url' | 'coordinates' | 'search';
};

type LocationFields = Pick<
  TrainingSession,
  'location_name' | 'address' | 'latitude' | 'longitude' | 'map_url'
>;

const HTTP_URL = /^https?:\/\/[^\s/?#]+[^\s]*$/i;

/** Only http(s) links are ever opened, whatever is stored. */
export function isSafeMapUrl(url: string | null | undefined): url is string {
  return typeof url === 'string' && HTTP_URL.test(url.trim());
}

function hasCoordinates(
  location: LocationFields,
): location is LocationFields & { latitude: number; longitude: number } {
  const { latitude, longitude } = location;
  return (
    typeof latitude === 'number' &&
    typeof longitude === 'number' &&
    Number.isFinite(latitude) &&
    Number.isFinite(longitude) &&
    Math.abs(latitude) <= 90 &&
    Math.abs(longitude) <= 180
  );
}

/** "Herastrau Park, Sos. Nordului 7-9" */
export function locationSearchText(location: Pick<LocationFields, 'location_name' | 'address'>): string {
  return [location.location_name, location.address]
    .map((part) => (part ?? '').trim())
    .filter((part) => part !== '')
    .join(', ');
}

/** Parentheses would end the Android `geo:` label early; encodeURIComponent leaves them alone. */
function encodeGeoLabel(label: string): string {
  return encodeURIComponent(label).replaceAll('(', '%28').replaceAll(')', '%29');
}

function googleSearchUrl(query: string): string {
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`;
}

export function buildMapsLink(location: LocationFields, platform: MapsPlatform): MapsLink {
  const label = location.location_name.trim();

  if (isSafeMapUrl(location.map_url)) {
    const url = location.map_url.trim();
    return { url, fallbackUrl: url, source: 'map_url' };
  }

  if (hasCoordinates(location)) {
    const point = `${location.latitude},${location.longitude}`;
    const fallbackUrl = googleSearchUrl(point);
    if (platform === 'ios') {
      return {
        url: `https://maps.apple.com/?ll=${point}&q=${encodeURIComponent(label)}`,
        fallbackUrl,
        source: 'coordinates',
      };
    }
    if (platform === 'android') {
      return {
        url: `geo:${point}?q=${point}(${encodeGeoLabel(label)})`,
        fallbackUrl,
        source: 'coordinates',
      };
    }
    return { url: fallbackUrl, fallbackUrl, source: 'coordinates' };
  }

  const query = locationSearchText(location);
  const fallbackUrl = googleSearchUrl(query);
  if (platform === 'ios') {
    return {
      url: `https://maps.apple.com/?q=${encodeURIComponent(query)}`,
      fallbackUrl,
      source: 'search',
    };
  }
  if (platform === 'android') {
    return { url: `geo:0,0?q=${encodeURIComponent(query)}`, fallbackUrl, source: 'search' };
  }
  return { url: fallbackUrl, fallbackUrl, source: 'search' };
}
