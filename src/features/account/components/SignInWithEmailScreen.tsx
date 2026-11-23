import { useRouter, type Href } from 'expo-router';
import { useEffect, useState } from 'react';
import { View } from 'react-native';

import { useCurrentMembership } from '@/features/community/hooks/useCurrentMembership';
import { WelcomeLegalLinks } from '@/features/legal/components/WelcomeLegalLinks';
import { KeyboardScreen } from '@/features/onboarding/components/KeyboardScreen';
import { userMessage } from '@/lib/errors';
import { reportError } from '@/lib/logger';
import { Button, ErrorState, LoadingState, Text, useTheme } from '@/ui';

import { confirmSignIn, requestSignInCode } from '../api/emailAuth';
import { SIGN_IN_SENT_NEUTRAL } from '../domain/emailLinking';
import { useAccountKind } from '../hooks/useAccountKind';
import { EmailCodeFlow, type EmailCodeActions, type EmailCodeCopy } from './EmailCodeFlow';

const SIGN_IN_ACTIONS: EmailCodeActions = {
  request: requestSignInCode,
  // The same call: sends a fresh code, and again never says whether the address has an account.
  resend: requestSignInCode,
  confirm: confirmSignIn,
};

const SIGN_IN_COPY: EmailCodeCopy = {
  emailHelper: 'The email you added to your account.',
  sendLabel: 'Send me a code',
  confirmLabel: 'Sign in',
  sentMessage: () => SIGN_IN_SENT_NEUTRAL,
};

/**
 * Welcome -> "I already have an account". Signing in swaps this device's
 * session for the existing account; the root gate then loads its communities
 * (the usual queries) and the usual terms gate still applies inside the app.
 * Someone whose account has no community any more is sent back to the welcome
 * screen to join one; nobody is asked to join or create a community again
 * while they still belong to one.
 */
export function SignInWithEmailScreen() {
  const router = useRouter();
  const { spacing } = useTheme();
  const account = useAccountKind();
  const membership = useCurrentMembership();
  const [signedIn, setSignedIn] = useState(false);

  // Right after sign-in: a linked account without any community goes back to the start.
  const noCommunity = signedIn && account?.kind === 'linked' && membership.state === 'none';
  useEffect(() => {
    if (noCommunity) router.replace('/welcome' as Href);
  }, [noCommunity, router]);

  const refresh = () => {
    membership.refetch().catch((error: unknown) => reportError('signIn.refetch', error));
  };

  return (
    <KeyboardScreen>
      <View style={{ alignItems: 'flex-start' }}>
        <Button
          label="Back"
          variant="ghost"
          size="sm"
          icon="chevron-left"
          onPress={() => router.back()}
          disabled={signedIn}
        />
      </View>

      {signedIn ? (
        membership.state === 'error' && membership.error ? (
          <ErrorState
            message={userMessage(membership.error.code, membership.error.field)}
            onRetry={refresh}
          />
        ) : (
          <LoadingState message="Signing you in" />
        )
      ) : (
        <>
          <View style={{ gap: spacing.sm }}>
            <Text variant="title" accessibilityRole="header">
              Sign in with your email
            </Text>
            <Text color="textMuted">
              For an account where you added an email in Profile, Secure your account. We email you a 6-digit
              code. There is no password.
            </Text>
          </View>
          <EmailCodeFlow
            actions={SIGN_IN_ACTIONS}
            copy={SIGN_IN_COPY}
            onConfirmed={() => setSignedIn(true)}
            testIdPrefix="sign-in"
          />
          <Text variant="caption" color="textMuted" align="center">
            Accounts without an email cannot be recovered. Join with an invitation code instead.
          </Text>
          <WelcomeLegalLinks />
        </>
      )}
    </KeyboardScreen>
  );
}
