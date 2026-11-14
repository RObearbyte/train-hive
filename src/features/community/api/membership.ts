import type { Community, Membership, Profile } from '@/lib/database.types';
import { toAppError } from '@/lib/errors';
import { getSupabase } from '@/lib/supabase';

export type CurrentMembership = {
  membership: Membership;
  community: Community;
  /** Null only if the profile row is missing, which redeeming an invitation prevents. */
  profile: Profile | null;
};

/**
 * The user's active membership with its community and their profile, or null
 * when they have none. A removed member gets null too: RLS hides every
 * membership row from them, so "removed" and "never joined" look the same.
 *
 * The schema allows several memberships; the app uses the earliest one.
 */
export async function fetchCurrentMembership(userId: string): Promise<CurrentMembership | null> {
  const supabase = getSupabase();

  const { data: rows, error } = await supabase
    .from('memberships')
    .select('*, community:communities(*)')
    .eq('user_id', userId)
    .eq('status', 'active')
    .order('joined_at', { ascending: true })
    .limit(1);
  if (error) throw toAppError(error);

  const row = rows[0];
  if (!row || !row.community) return null;
  const { community, ...membership } = row;

  const { data: profile, error: profileError } = await supabase
    .from('profiles')
    .select('*')
    .eq('id', userId)
    .maybeSingle();
  if (profileError) throw toAppError(profileError);

  return { membership, community, profile };
}
