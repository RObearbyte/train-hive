/**
 * The typed Supabase client.
 *
 * Importing this file never throws: when the env vars are missing,
 * `isSupabaseConfigured` is false and the root layout shows a setup screen
 * instead of the app (see docs/SUPABASE_SETUP.md). `getSupabase()` is only
 * called from feature `api/` functions, which that screen keeps unreachable.
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { AppState, Platform } from 'react-native';

import { authStorage } from './authStorage';
import type { Database } from './database.types';

// Expo inlines EXPO_PUBLIC_* at build time; they must be read as static property accesses.
const supabaseUrl = (process.env.EXPO_PUBLIC_SUPABASE_URL ?? '').trim();
const supabaseAnonKey = (process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY ?? '').trim();

export const isSupabaseConfigured = /^https?:\/\/\S+$/i.test(supabaseUrl) && supabaseAnonKey !== '';

export type TypedSupabaseClient = SupabaseClient<Database>;

/** Fixed key so the app can tell "no account on this device" from "account stored, but unreachable". */
export const AUTH_STORAGE_KEY = 'trainhive-auth';

/**
 * True when a session is persisted on this device, even if it cannot be used
 * right now (an expired token cannot be refreshed while offline, and auth-js
 * then reports no session).
 */
export async function hasStoredSession(): Promise<boolean> {
  const stored = await authStorage.getItem(AUTH_STORAGE_KEY);
  return stored !== null && stored !== '';
}

function createTypedClient(): TypedSupabaseClient {
  const client = createClient<Database>(supabaseUrl, supabaseAnonKey, {
    auth: {
      storage: authStorage,
      storageKey: AUTH_STORAGE_KEY,
      persistSession: true,
      autoRefreshToken: true,
      // No OAuth / magic-link redirects: sessions are anonymous.
      detectSessionInUrl: false,
    },
  });

  // On native there is no "tab visibility": refresh tokens only while the app
  // is in the foreground, and catch up as soon as it returns.
  if (Platform.OS !== 'web') {
    AppState.addEventListener('change', (state) => {
      if (state === 'active') void client.auth.startAutoRefresh();
      else void client.auth.stopAutoRefresh();
    });
  }
  return client;
}

const client: TypedSupabaseClient | null = isSupabaseConfigured ? createTypedClient() : null;

/** The client. Throws when the backend is not configured (a programming error past the root gate). */
export function getSupabase(): TypedSupabaseClient {
  if (!client) {
    throw new Error(
      'Supabase is not configured: set EXPO_PUBLIC_SUPABASE_URL and EXPO_PUBLIC_SUPABASE_ANON_KEY (docs/SUPABASE_SETUP.md).',
    );
  }
  return client;
}
