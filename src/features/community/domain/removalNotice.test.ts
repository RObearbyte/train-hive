import { describe, expect, it } from 'vitest';

import { removalNotice } from './removalNotice';

const A = { community_id: 'a', name: 'Alpha Pack' };
const B = { community_id: 'b', name: 'Beta Club' };
const C = { community_id: 'c', name: 'Gamma' };

describe('removalNotice', () => {
  it('names both communities when the active one disappeared from my list', () => {
    expect(
      removalNotice({ activeId: 'a', communities: [A, B] }, { activeId: 'b', communities: [B] }),
    ).toBe("You're no longer a member of Alpha Pack; switched to Beta Club.");
  });

  it('says nothing for a switch the user made (the old community is still mine)', () => {
    expect(removalNotice({ activeId: 'a', communities: [A, B] }, { activeId: 'b', communities: [A, B] })).toBeNull();
  });

  it('says nothing when nothing changed, or when another community was removed', () => {
    expect(removalNotice({ activeId: 'a', communities: [A, B] }, { activeId: 'a', communities: [A, B] })).toBeNull();
    expect(removalNotice({ activeId: 'a', communities: [A, B, C] }, { activeId: 'a', communities: [A, B] })).toBeNull();
  });

  it('says nothing without a previous or a new active community (first load, or no community left)', () => {
    expect(removalNotice({ activeId: null, communities: [] }, { activeId: 'a', communities: [A] })).toBeNull();
    expect(removalNotice({ activeId: 'a', communities: [A] }, { activeId: null, communities: [] })).toBeNull();
  });

  it('says nothing when the previous active id was never in the known list', () => {
    expect(removalNotice({ activeId: 'z', communities: [A] }, { activeId: 'a', communities: [A] })).toBeNull();
  });
});
