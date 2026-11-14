/**
 * Where the Supabase session is persisted.
 *
 * - iOS / Android: expo-secure-store (Keychain / Keystore-encrypted), chunked
 *   because one entry cannot reliably hold the whole session JSON.
 * - Web: localStorage (there is no secure store in a browser).
 */
import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';

import { createChunkedStorage, type AsyncStringStorage, type KeyValueBackend } from './chunkedStorage';

// Readable after the first unlock so a token refresh can run while the screen is locked.
const secureOptions: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK,
};

const secureStoreBackend: KeyValueBackend = {
  getItem: (key) => SecureStore.getItemAsync(key, secureOptions),
  setItem: (key, value) => SecureStore.setItemAsync(key, value, secureOptions),
  removeItem: (key) => SecureStore.deleteItemAsync(key, secureOptions),
};

function webStorage(): AsyncStringStorage {
  const store = typeof localStorage === 'undefined' ? null : localStorage;
  return {
    getItem: async (key) => store?.getItem(key) ?? null,
    setItem: async (key, value) => {
      store?.setItem(key, value);
    },
    removeItem: async (key) => {
      store?.removeItem(key);
    },
  };
}

export const authStorage: AsyncStringStorage =
  Platform.OS === 'web' ? webStorage() : createChunkedStorage(secureStoreBackend);
