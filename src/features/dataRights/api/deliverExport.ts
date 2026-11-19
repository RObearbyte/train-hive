/**
 * Native: writes the export to a file in the cache directory and opens the
 * system share sheet (Save to Files, Drive, email, ...). Falls back to sharing
 * the text itself when files or the share sheet are unavailable. The web
 * version is `deliverExport.web.ts`.
 *
 * The file holds personal data: older export files are deleted before a new
 * one is written, so at most one stays in the cache (the system also empties
 * the cache when space runs low). The content is never logged.
 */
import { File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import { Share } from 'react-native';

import { reportError } from '@/lib/logger';

import { EXPORT_MIME_TYPE } from '../domain/exportFile';

export type DeliveryMethod = 'file' | 'text' | 'download';

const OWN_FILE = /^trainhive-data-.*\.json$/;

function removeOldExports(): void {
  try {
    for (const entry of Paths.cache.list()) {
      if (entry instanceof File && OWN_FILE.test(entry.name)) entry.delete();
    }
  } catch (error) {
    reportError('export.cleanup', error);
  }
}

async function shareAsText(text: string): Promise<DeliveryMethod> {
  await Share.share({ title: 'My TrainHive data', message: text });
  return 'text';
}

export async function deliverExport(fileName: string, text: string): Promise<DeliveryMethod> {
  let file: File;
  try {
    if (!(await Sharing.isAvailableAsync())) return await shareAsText(text);
    removeOldExports();
    file = new File(Paths.cache, fileName);
    file.create({ overwrite: true });
    await file.write(text);
  } catch (error) {
    // No file access (or no share sheet): the text can still leave the app.
    reportError('export.writeFile', error);
    return await shareAsText(text);
  }
  await Sharing.shareAsync(file.uri, {
    mimeType: EXPORT_MIME_TYPE,
    UTI: 'public.json',
    dialogTitle: 'My TrainHive data',
  });
  return 'file';
}
