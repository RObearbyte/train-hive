import { SecureAccountScreen } from '@/features/account/components/SecureAccountScreen';

/** One-time first page after joining or creating the first community (skippable); opened by OneTimePagesRedirect. */
export default function SecureAccountRoute() {
  return <SecureAccountScreen />;
}
