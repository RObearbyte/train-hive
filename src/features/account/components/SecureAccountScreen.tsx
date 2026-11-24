import { useRouter, type Href } from 'expo-router';
import { View } from 'react-native';

import { KeyboardScreen } from '@/features/onboarding/components/KeyboardScreen';
import { Banner, Button, Text, useTheme } from '@/ui';

import { maskEmail } from '../domain/emailLinking';
import { useAccountKind } from '../hooks/useAccountKind';
import { SecureAccountForm } from './SecureAccountForm';

/**
 * The one-time, skippable page shown right after a person joins or creates
 * their first community (the redirect marks it seen as soon as it opens, so
 * the back gesture never brings it back). Same linking steps as Profile,
 * Secure your account; once the email is confirmed the session becomes a
 * linked account and the page offers Continue.
 */
export function SecureAccountScreen() {
  const router = useRouter();
  const { spacing } = useTheme();
  const account = useAccountKind();

  const leave = () => {
    if (router.canGoBack()) router.back();
    else router.replace('/' as Href);
  };

  const linked = account?.kind === 'linked';

  return (
    <KeyboardScreen>
      <View style={{ gap: spacing.sm }}>
        <Text variant="title" accessibilityRole="header">
          Secure your account
        </Text>
        <Text color="textMuted">
          Your account lives only on this phone. Add your email so you can sign in again on another phone, or
          if you lose this one. We only use it for sign-in codes. It is optional.
        </Text>
      </View>

      {linked ? (
        <>
          <Banner
            tone="success"
            title={account.email ? `Account secured with ${maskEmail(account.email)}` : 'Account secured with your email'}
            message="To use this account on another phone, choose I already have an account on the welcome screen and enter the code we email you."
          />
          <Button label="Continue" fullWidth onPress={leave} testID="secure-account-continue" />
        </>
      ) : (
        <>
          <SecureAccountForm
            pendingEmail={account?.kind === 'anonymous' ? account.pendingEmail : null}
            testIdPrefix="secure-account-welcome"
          />
          <Button label="Skip for now" variant="secondary" fullWidth onPress={leave} testID="secure-account-skip" />
          <Text variant="caption" color="textMuted" align="center">
            You can do this later in Profile, Secure your account.
          </Text>
        </>
      )}
    </KeyboardScreen>
  );
}
