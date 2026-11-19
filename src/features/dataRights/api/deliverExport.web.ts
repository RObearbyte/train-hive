/**
 * Web: turns the export into a Blob and starts a browser download. The object
 * URL is revoked right after, so nothing lingers in memory.
 */
import { AppError } from '@/lib/errors';

import { EXPORT_MIME_TYPE } from '../domain/exportFile';

export type DeliveryMethod = 'file' | 'text' | 'download';

export async function deliverExport(fileName: string, text: string): Promise<DeliveryMethod> {
  if (typeof document === 'undefined' || typeof URL === 'undefined' || typeof Blob === 'undefined') {
    throw new AppError('unknown', { message: 'This browser cannot save files.' });
  }
  const blob = new Blob([text], { type: `${EXPORT_MIME_TYPE};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  try {
    const link = document.createElement('a');
    link.href = url;
    link.download = fileName;
    link.rel = 'noopener';
    link.style.display = 'none';
    document.body.appendChild(link);
    link.click();
    link.remove();
  } finally {
    // The download has started synchronously; give the browser a moment before releasing the data.
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }
  return 'download';
}
