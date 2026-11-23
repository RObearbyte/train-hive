import { describe, expect, it } from 'vitest';

import type { CommunityEmergencyList, MemberEmergencyInfo } from '@/lib/database.types';

import {
  contactSummary,
  emergencyListText,
  hasSharedInfo,
  infoAccessibilityLabel,
  isCommunityEmergencyList,
  isMemberEmergencyInfo,
  telHref,
} from './emergency';

const member = (overrides: Partial<MemberEmergencyInfo> = {}): MemberEmergencyInfo => ({
  user_id: 'u1',
  display_name: 'Ana Test',
  role: 'member',
  emergency_contact_name: 'Ion Test',
  emergency_contact_phone: '+40 712 345 678',
  emergency_contact_relationship: 'Brother',
  tshirt_size: 'M',
  has_emergency_contact: true,
  updated_at: '2026-11-23T10:00:00Z',
  ...overrides,
});

const nothing = member({
  emergency_contact_name: null,
  emergency_contact_phone: null,
  emergency_contact_relationship: null,
  tshirt_size: null,
  has_emergency_contact: false,
  updated_at: null,
});

describe('shared info', () => {
  it('says whether anything is shared', () => {
    expect(hasSharedInfo(member())).toBe(true);
    expect(hasSharedInfo(member({ has_emergency_contact: false, tshirt_size: 'S' }))).toBe(true);
    expect(hasSharedInfo(nothing)).toBe(false);
  });

  it('summarizes the contact', () => {
    expect(contactSummary(member())).toBe('Ion Test (Brother)');
    expect(contactSummary(member({ emergency_contact_relationship: null }))).toBe('Ion Test');
    expect(contactSummary(nothing)).toBeNull();
  });

  it('reads out the details for a screen reader', () => {
    expect(infoAccessibilityLabel(member())).toBe(
      'Ana Test, emergency contact Ion Test (Brother), phone +40 712 345 678, T-shirt size M',
    );
    expect(infoAccessibilityLabel(nothing)).toBe('Ana Test: nothing shared');
  });
});

describe('telHref', () => {
  it('keeps only digits and a leading plus', () => {
    expect(telHref('+40 (712) 345-678')).toBe('tel:+40712345678');
    expect(telHref('0712 345 678')).toBe('tel:0712345678');
    expect(telHref('  +1.555.0100')).toBe('tel:+15550100');
  });

  it('gives nothing for no phone or no digits, and never passes other characters on', () => {
    expect(telHref(null)).toBeNull();
    expect(telHref('---')).toBeNull();
    expect(telHref('0712;rm 345')).toBe('tel:0712345');
  });
});

describe('emergencyListText', () => {
  const list: CommunityEmergencyList = {
    community_id: 'c1',
    members: [member(), member({ user_id: 'u2', display_name: 'Bob Test', emergency_contact_name: null, emergency_contact_phone: null, emergency_contact_relationship: null, has_emergency_contact: false, tshirt_size: 'XL' })],
    truncated: false,
  };

  it('prints one block per member with the contact and the size', () => {
    expect(emergencyListText(list, 'Test Club')).toBe(
      [
        'Emergency contacts and T-shirt sizes: Test Club',
        '2 members shared details.',
        '',
        'Ana Test',
        '  Emergency contact: Ion Test (Brother), +40 712 345 678',
        '  T-shirt size: M',
        '',
        'Bob Test',
        '  Emergency contact: none',
        '  T-shirt size: XL',
      ].join('\n'),
    );
  });

  it('handles one member and says when the list was cut', () => {
    const text = emergencyListText({ ...list, members: [member()], truncated: true }, 'Test Club');
    expect(text).toContain('1 member shared details.');
    expect(text.endsWith('The list was cut at 500 members.')).toBe(true);
  });

  it('has no member lines for an empty list', () => {
    expect(emergencyListText({ ...list, members: [] }, 'Test Club')).toBe(
      'Emergency contacts and T-shirt sizes: Test Club\n0 members shared details.',
    );
  });
});

describe('shape checks', () => {
  it('accepts what the server returns and rejects other shapes', () => {
    expect(isMemberEmergencyInfo(member())).toBe(true);
    expect(isMemberEmergencyInfo({ ...member(), has_emergency_contact: 'yes' })).toBe(false);
    expect(isMemberEmergencyInfo(null)).toBe(false);
    expect(isCommunityEmergencyList({ community_id: 'c', members: [member()], truncated: false })).toBe(true);
    expect(isCommunityEmergencyList({ community_id: 'c', members: [{}], truncated: false })).toBe(false);
    expect(isCommunityEmergencyList({ community_id: 'c', members: [] })).toBe(false);
  });
});
