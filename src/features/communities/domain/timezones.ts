/**
 * Time zone list, search and display helpers for the community time zone
 * picker. Nothing here reads the clock: `now` is a parameter and only feeds
 * the "local time there" sanity check.
 */
import { tzOffset } from '@date-fns/tz';

import { deviceTimeZone, zoneCityName } from '@/lib/datetime';

import { isCommunityTimeZone } from './communityForm';

/** Used when the runtime cannot list zones (older Hermes builds, some web engines). */
export const FALLBACK_TIME_ZONES: readonly string[] = [
  'UTC',
  'Africa/Cairo',
  'Africa/Casablanca',
  'Africa/Johannesburg',
  'Africa/Lagos',
  'Africa/Nairobi',
  'America/Anchorage',
  'America/Argentina/Buenos_Aires',
  'America/Bogota',
  'America/Chicago',
  'America/Denver',
  'America/Halifax',
  'America/Lima',
  'America/Los_Angeles',
  'America/Mexico_City',
  'America/New_York',
  'America/Phoenix',
  'America/Santiago',
  'America/Sao_Paulo',
  'America/St_Johns',
  'America/Toronto',
  'America/Vancouver',
  'Asia/Bangkok',
  'Asia/Dhaka',
  'Asia/Dubai',
  'Asia/Hong_Kong',
  'Asia/Jakarta',
  'Asia/Jerusalem',
  'Asia/Karachi',
  'Asia/Kathmandu',
  'Asia/Kolkata',
  'Asia/Manila',
  'Asia/Seoul',
  'Asia/Shanghai',
  'Asia/Singapore',
  'Asia/Tehran',
  'Asia/Tokyo',
  'Atlantic/Azores',
  'Atlantic/Reykjavik',
  'Australia/Adelaide',
  'Australia/Brisbane',
  'Australia/Melbourne',
  'Australia/Perth',
  'Australia/Sydney',
  'Europe/Amsterdam',
  'Europe/Athens',
  'Europe/Belgrade',
  'Europe/Berlin',
  'Europe/Brussels',
  'Europe/Bucharest',
  'Europe/Budapest',
  'Europe/Dublin',
  'Europe/Helsinki',
  'Europe/Istanbul',
  'Europe/Kyiv',
  'Europe/Lisbon',
  'Europe/London',
  'Europe/Madrid',
  'Europe/Moscow',
  'Europe/Paris',
  'Europe/Prague',
  'Europe/Rome',
  'Europe/Sofia',
  'Europe/Stockholm',
  'Europe/Vienna',
  'Europe/Warsaw',
  'Europe/Zurich',
  'Pacific/Auckland',
  'Pacific/Fiji',
  'Pacific/Honolulu',
];

type ZoneSource = () => readonly string[] | undefined;

function runtimeZones(): readonly string[] | undefined {
  const intl = Intl as unknown as { supportedValuesOf?: (key: string) => string[] };
  if (typeof intl.supportedValuesOf !== 'function') return undefined;
  return intl.supportedValuesOf('timeZone');
}

/**
 * Selectable zones: the runtime's own list when it has one
 * (`Intl.supportedValuesOf('timeZone')`), else the built-in list. Only names
 * the server would accept are kept, `UTC` is always offered, and the device's
 * zone is included so the default is always in the list. Sorted by name.
 */
export function listTimeZones(
  source: ZoneSource = runtimeZones,
  device: string | null = deviceTimeZone(),
): string[] {
  let found: readonly string[] | undefined;
  try {
    found = source();
  } catch {
    // The runtime refused to list zones: the built-in list is the intended fallback.
    found = undefined;
  }
  const base = found && found.length > 0 ? found : FALLBACK_TIME_ZONES;
  const zones = new Set<string>(['UTC']);
  for (const zone of base) if (isCommunityTimeZone(zone) && !zone.startsWith('Etc/')) zones.add(zone);
  if (device !== null && isCommunityTimeZone(device)) zones.add(device);
  return [...zones].sort((a, b) => a.localeCompare(b, 'en'));
}

/** The zone to preselect: the device's when the server would accept it, else UTC. */
export function defaultTimeZone(device: string | null = deviceTimeZone()): string {
  return device !== null && isCommunityTimeZone(device) ? device : 'UTC';
}

function searchText(zone: string): string {
  return zone.toLowerCase().replace(/[_/-]+/g, ' ');
}

/**
 * Zones matching `query` (case-insensitive, every word must appear in the
 * name; "new york" finds America/New_York). Zones whose city starts with the
 * query come first. An empty query returns the list unchanged.
 */
export function searchTimeZones(zones: readonly string[], query: string): string[] {
  const words = query.toLowerCase().replace(/[_/-]+/g, ' ').split(/\s+/).filter(Boolean);
  if (words.length === 0) return [...zones];
  const matches = zones.filter((zone) => {
    const text = searchText(zone);
    return words.every((word) => text.includes(word));
  });
  const first = words.join(' ');
  const rank = (zone: string) => (searchText(zoneCityName(zone)).startsWith(first) ? 0 : 1);
  return matches
    .map((zone, index) => ({ zone, index }))
    .sort((a, b) => rank(a.zone) - rank(b.zone) || a.index - b.index)
    .map((item) => item.zone);
}

/** "Bucharest (Europe/Bucharest)"; `UTC` stays "UTC". */
export function zoneLabel(zone: string): string {
  return zone === 'UTC' ? 'UTC' : `${zoneCityName(zone)} (${zone})`;
}

/** "UTC+02:00", "UTC-03:30", "UTC" at `now`. */
export function utcOffsetLabel(zone: string, now: Date): string {
  const minutes = Math.round(tzOffset(zone, now));
  if (minutes === 0) return 'UTC';
  const sign = minutes < 0 ? '-' : '+';
  const abs = Math.abs(minutes);
  const hh = String(Math.floor(abs / 60)).padStart(2, '0');
  const mm = String(abs % 60).padStart(2, '0');
  return `UTC${sign}${hh}:${mm}`;
}

/** The wall-clock time in `zone` at `now`, 24-hour, e.g. "14:32". For display only. */
export function localTimeIn(zone: string, now: Date): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: zone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(now);
}

/** "14:32 (UTC+02:00)": the sanity check shown under the picker. */
export function localTimeSummary(zone: string, now: Date): string {
  return `${localTimeIn(zone, now)} (${utcOffsetLabel(zone, now)})`;
}
