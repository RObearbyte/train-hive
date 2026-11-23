import type { AboutYou } from '@/lib/database.types';

/** Nothing stored, no agreement on record; the server year is 2026 (range 1926 to 2010). */
export function emptyAboutYou(overrides: Partial<AboutYou> = {}): AboutYou {
  return {
    has_data: false,
    birth_year: null,
    gender: null,
    emergency_contact_name: null,
    emergency_contact_phone: null,
    emergency_contact_relationship: null,
    tshirt_size: null,
    updated_at: null,
    birth_year_min: 1926,
    birth_year_max: 2010,
    consents: { profile_demographics: false, emergency_contact: false },
    ...overrides,
  };
}
