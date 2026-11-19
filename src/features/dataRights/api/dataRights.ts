import type { MyDataExport, MyDeletionBlockers } from '@/lib/database.types';
import { toAppError } from '@/lib/errors';
import { getSupabase } from '@/lib/supabase';

import { parseBlockers } from '../domain/deletion';
import { parseExport } from '../domain/exportFile';

/** `export_my_data`: everything personal about the caller. Throws AppError (`rate_limited`, `not_authenticated`, ...). */
export async function exportMyData(): Promise<MyDataExport> {
  const { data, error } = await getSupabase().rpc('export_my_data');
  if (error) throw toAppError(error);
  return parseExport(data);
}

/** `my_deletion_blockers`: what stands in the way of deleting the account, and what is deleted with it. */
export async function fetchDeletionBlockers(): Promise<MyDeletionBlockers> {
  const { data, error } = await getSupabase().rpc('my_deletion_blockers');
  if (error) throw toAppError(error);
  return parseBlockers(data);
}

/**
 * `delete_my_account`. Throws AppError; the original error is kept on it so
 * the `details` of a `last_organizer` refusal can be read.
 */
export async function deleteMyAccount(): Promise<void> {
  const { error } = await getSupabase().rpc('delete_my_account');
  if (error) throw toAppError(error);
}
