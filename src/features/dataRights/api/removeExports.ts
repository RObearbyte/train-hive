/**
 * Native: deletes the downloaded data files from the cache directory. Called
 * when someone leaves the account on this device (sign out, account deletion)
 * and before a new export is written. The web version is `removeExports.web.ts`.
 */
import { File, Paths } from 'expo-file-system';

import { removeExportFiles } from '../domain/exportFile';

/** Throws when the cache cannot be listed or a file cannot be removed. */
export async function removeExportedFiles(): Promise<void> {
  const { failed } = removeExportFiles(() =>
    Paths.cache
      .list()
      .map((entry) => ({
        name: entry.name,
        isFile: entry instanceof File,
        delete: () => entry.delete(),
      })),
  );
  if (failed > 0) throw new Error(`${failed} exported file(s) could not be removed`);
}
