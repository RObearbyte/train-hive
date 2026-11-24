import { View } from 'react-native';

import { FEATURES } from '@/features/legal/constants';
import { Banner, Card, Text, useTheme } from '@/ui';

import { OTP_LENGTH, maskEmail } from '../domain/emailLinking';
import { useAccountKind } from '../hooks/useAccountKind';
import { SecureAccountForm } from './SecureAccountForm';

/**
 * Profile -> "Secure your account". An anonymous account can add an email
 * (6-digit code, no password) to sign in again on another device or after a
 * reinstall. A linked account shows the masked address. There is no "remove
 * email": Supabase Auth cannot unlink the only identity of a user, so the
 * address leaves with "Delete my account".
 */
export function SecureAccountSection() {
  const { spacing } = useTheme();
  const account = useAccountKind();
  if (!FEATURES.accountLinking || account === null) return null;

  if (account.kind === 'linked') {
    return (
      <View style={{ gap: spacing.sm }}>
        <Text variant="heading">Secure your account</Text>
        <Card style={{ gap: spacing.sm }}>
          <Banner
            tone="success"
            title={
              account.email
                ? `Account secured with ${maskEmail(account.email)}`
                : 'Account secured with your email'
            }
            message="To use this account on another phone or after reinstalling, choose I already have an account on the welcome screen and enter the code we email you."
          />
          <Text variant="caption" color="textMuted">
            Your email is stored with our sign-in provider. Deleting your account (Profile, Privacy) deletes it too.
          </Text>
        </Card>
      </View>
    );
  }

  return (
    <View style={{ gap: spacing.sm }}>
      <Text variant="heading">Secure your account</Text>
      <Card style={{ gap: spacing.md }}>
        <Text>
          Add your email so you can get back into this account if you lose or change your phone. It is optional.
          We email you a {OTP_LENGTH}-digit code: no password.
        </Text>
        <SecureAccountForm pendingEmail={account.pendingEmail} testIdPrefix="secure-account" />
      </Card>
    </View>
  );
}
