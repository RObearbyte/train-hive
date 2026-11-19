import { useState } from 'react';
import { View } from 'react-native';

import { ConfirmDialog } from '@/features/community/components/ConfirmDialog';
import { userMessage } from '@/lib/errors';
import { Button, Text, useTheme } from '@/ui';

import { SIGN_OUT_MESSAGE, SIGN_OUT_TITLE } from '../domain/signOut';
import { useSignOut } from '../hooks/useSignOut';

/** Profile -> "Sign out", with a confirmation that says the account cannot be recovered. */
export function SignOutSection() {
  const { spacing } = useTheme();
  const signOut = useSignOut();
  const [open, setOpen] = useState(false);

  return (
    <View style={{ gap: spacing.sm }}>
      <Button
        label="Sign out"
        variant="secondary"
        icon="close"
        fullWidth
        accessibilityHint="Asks for confirmation first"
        onPress={() => {
          signOut.reset();
          setOpen(true);
        }}
      />
      <Text variant="caption" color="textMuted">
        Signing out removes this account from this device for good.
      </Text>
      <ConfirmDialog
        visible={open}
        title={SIGN_OUT_TITLE}
        message={SIGN_OUT_MESSAGE}
        confirmLabel="Sign out"
        cancelLabel="Stay signed in"
        destructive
        pending={signOut.isPending}
        error={signOut.error ? userMessage(signOut.error.code, signOut.error.field) : null}
        onConfirm={() => signOut.mutate()}
        onCancel={() => setOpen(false)}
      />
    </View>
  );
}
