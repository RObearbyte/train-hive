/**
 * The one place errors are reported, so nothing is silently swallowed and a
 * crash reporter can be plugged in later. Logs the original backend / runtime
 * message, which `AppError` keeps, never just the friendly text.
 */
import { toAppError } from './errors';

export function reportError(context: string, error: unknown): void {
  const appError = toAppError(error);
  console.warn(`[${context}] ${appError.code}: ${appError.message}`, appError.original ?? '');
}
