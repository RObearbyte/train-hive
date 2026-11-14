import type { ReactNode } from 'react';
import { KeyboardAvoidingView, Platform } from 'react-native';

import { Screen } from '@/ui';

/** Scrolling screen that keeps its content (and the submit button) above the keyboard. */
export function KeyboardScreen({ children }: { children: ReactNode }) {
  return (
    <KeyboardAvoidingView
      style={{ flex: 1 }}
      behavior={Platform.OS === 'web' ? undefined : 'padding'}
    >
      <Screen scroll>{children}</Screen>
    </KeyboardAvoidingView>
  );
}
