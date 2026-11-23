import { beforeEach, describe, expect, it, vi } from 'vitest';

import { PRIVACY_VERSION } from '../constants';
import { recordConsent } from './consents';

const rpc = vi.fn();
vi.mock('@/lib/supabase', () => ({ getSupabase: () => ({ rpc }) }));
vi.mock('./acceptanceStorage', () => ({ readLocalAcceptance: vi.fn() }));

const event = { purpose: 'x', granted: true, document_version: PRIVACY_VERSION, at: 'now', changed: true };

beforeEach(() => {
  rpc.mockReset();
});

describe('recordConsent', () => {
  it('sends the bundled privacy version for every optional purpose', async () => {
    rpc.mockResolvedValue({ data: event, error: null });
    for (const purpose of ['profile_demographics', 'emergency_contact', 'push_notifications', 'workout_logs'] as const) {
      await recordConsent(purpose);
      expect(rpc).toHaveBeenLastCalledWith('record_consent', { p_purpose: purpose, p_document_version: PRIVACY_VERSION });
    }
  });

  it('keeps the explicit string for terms and sends none for age', async () => {
    rpc.mockResolvedValue({ data: event, error: null });
    await recordConsent('terms_privacy', 'terms:2|privacy:2');
    expect(rpc).toHaveBeenLastCalledWith('record_consent', { p_purpose: 'terms_privacy', p_document_version: 'terms:2|privacy:2' });
    await recordConsent('age_16');
    expect(rpc).toHaveBeenLastCalledWith('record_consent', { p_purpose: 'age_16', p_document_version: null });
  });

  it('maps validation_failed:document_version to app_update_required for an optional purpose', async () => {
    rpc.mockResolvedValue({
      data: null,
      error: { code: 'P0001', message: 'validation_failed:document_version', details: null, hint: null },
    });
    await expect(recordConsent('emergency_contact')).rejects.toMatchObject({ code: 'app_update_required' });
  });

  it('leaves other errors alone', async () => {
    rpc.mockResolvedValue({ data: null, error: { code: 'P0001', message: 'rate_limited', details: null, hint: null } });
    await expect(recordConsent('profile_demographics')).rejects.toMatchObject({ code: 'rate_limited' });
  });
});
