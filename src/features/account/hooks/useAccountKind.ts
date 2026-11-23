import { useSession } from '@/features/community/hooks/SessionProvider';

import { accountKindOf, type AccountKind } from '../domain/emailLinking';

/** Anonymous, or linked to an email, for the signed-in session; null while there is no session. */
export function useAccountKind(): AccountKind | null {
  const { session } = useSession();
  return session ? accountKindOf(session.user) : null;
}
