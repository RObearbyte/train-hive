import { useMutation } from '@tanstack/react-query';

import { toAppError, type AppError } from '@/lib/errors';
import { reportError } from '@/lib/logger';

import { exportMyData } from '../api/dataRights';
import { deliverExport, type DeliveryMethod } from '../api/deliverExport';
import {
  exportFileName,
  serializeExport,
  summarizeExport,
  type ExportSummary,
} from '../domain/exportFile';

export type DownloadResult = { fileName: string; summary: ExportSummary; method: DeliveryMethod };

/**
 * Prepares the export on the server and hands the file to the person. Only the
 * summary is kept in the mutation result: the data itself is never stored in
 * the query cache and never logged (errors are logged by code only).
 */
export function useDownloadMyData() {
  return useMutation<DownloadResult, AppError, void>({
    mutationFn: async () => {
      try {
        const payload = await exportMyData();
        const fileName = exportFileName(payload.generated_at);
        const method = await deliverExport(fileName, serializeExport(payload));
        return { fileName, summary: summarizeExport(payload), method };
      } catch (error) {
        throw toAppError(error);
      }
    },
    onError: (error) => reportError('dataExport', error.code),
  });
}
