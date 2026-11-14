import { QueryClientProvider } from '@tanstack/react-query';
import { DarkTheme, DefaultTheme, Stack, ThemeProvider } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { BackendNotConfigured } from '@/features/community/components/BackendNotConfigured';
import { SessionProvider } from '@/features/community/hooks/SessionProvider';
import { useAppGate } from '@/features/community/hooks/useAppGate';
import { bindQueryLifecycle, queryClient } from '@/lib/queryClient';
import { isSupabaseConfigured } from '@/lib/supabase';
import { ErrorState, LoadingState, Screen, useTheme } from '@/ui';

// Keep the native splash up until the session gate knows where to go, so a
// returning member never sees onboarding flash by.
void SplashScreen.preventAutoHideAsync();
bindQueryLifecycle();

function useNavigationTheme() {
  const { scheme, colors } = useTheme();
  const base = scheme === 'dark' ? DarkTheme : DefaultTheme;
  return {
    ...base,
    colors: {
      ...base.colors,
      primary: colors.primary,
      background: colors.background,
      card: colors.surface,
      text: colors.text,
      border: colors.border,
      notification: colors.accent,
    },
  };
}

function RootNavigator() {
  const { route, errorMessage, retry } = useAppGate();
  const { colors } = useTheme();

  useEffect(() => {
    if (route !== 'loading') SplashScreen.hide();
  }, [route]);

  if (route === 'loading') {
    // Behind the splash on a cold start; visible only after a retry.
    return (
      <Screen>
        <LoadingState style={{ flex: 1 }} />
      </Screen>
    );
  }

  if (route === 'error') {
    return (
      <Screen>
        <ErrorState
          title="Can't reach TrainHive"
          message={errorMessage}
          onRetry={retry}
          style={{ flex: 1 }}
        />
      </Screen>
    );
  }

  return (
    <Stack
      screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.background } }}
    >
      <Stack.Protected guard={route === 'app'} redirectTo="/welcome">
        <Stack.Screen name="(app)" />
      </Stack.Protected>
      <Stack.Protected guard={route === 'onboarding'} redirectTo="/">
        <Stack.Screen name="(onboarding)" />
      </Stack.Protected>
    </Stack>
  );
}

function NotConfigured() {
  useEffect(() => {
    SplashScreen.hide();
  }, []);
  return <BackendNotConfigured />;
}

export default function RootLayout() {
  const navigationTheme = useNavigationTheme();

  return (
    <SafeAreaProvider>
      <ThemeProvider value={navigationTheme}>
        <StatusBar style="auto" />
        {isSupabaseConfigured ? (
          <QueryClientProvider client={queryClient}>
            <SessionProvider>
              <RootNavigator />
            </SessionProvider>
          </QueryClientProvider>
        ) : (
          <NotConfigured />
        )}
      </ThemeProvider>
    </SafeAreaProvider>
  );
}
