import { useState } from 'react';
import { View } from 'react-native';

import { useAccountKind } from '@/features/account/hooks/useAccountKind';
import { ConfirmDialog } from '@/features/community/components/ConfirmDialog';
import { userMessage } from '@/lib/errors';
import { Button, Text, useTheme } from '@/ui';

import { signOutCopy, SIGN_OUT_TITLE } from '../domain/signOut';
import { useSignOut } from '../hooks/useSignOut';

/** Profile -> "Sign out". The confirmation says the account cannot be recovered, or, once an email is linked, that it can be signed into again. */
export function SignOutSection() {
  const { spacing } = useTheme();
  const signOut = useSignOut();
  const [open, setOpen] = useState(false);
  const copy = signOutCopy(useAccountKind()?.kind === 'linked');

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
        {copy.caption}
      </Text>
      <ConfirmDialog
        visible={open}
        title={SIGN_OUT_TITLE}
        message={copy.message}
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
