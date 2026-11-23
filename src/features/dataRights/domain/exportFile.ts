/**
 * "Download my data": naming, serialising and describing the export. Pure
 * TypeScript (the file writing and sharing live in `api/deliverExport*.ts`).
 * The payload is personal data: nothing here logs it.
 */
import type { MyDataExport } from '@/lib/database.types';
import { AppError, toAppError, userMessage } from '@/lib/errors';

export const EXPORT_MIME_TYPE = 'application/json';

/** The server allows this many exports per rolling hour (`rate_limited` after that). */
export const EXPORT_LIMIT_PER_HOUR = 10;

const ISO_DATE = /^(\d{4}-\d{2}-\d{2})(?:[T ]|$)/;

/**
 * `trainhive-data-<date>.json`. The date is the server's `generated_at` (UTC
 * date); the device clock is never read. Without a usable date the name is
 * `trainhive-data.json`.
 */
export function exportFileName(generatedAt: string | null | undefined): string {
  const match = typeof generatedAt === 'string' ? ISO_DATE.exec(generatedAt) : null;
  return match ? `trainhive-data-${match[1]}.json` : 'trainhive-data.json';
}

/** Pretty-printed JSON, easy to read in any text editor. */
export function serializeExport(payload: MyDataExport): string {
  return JSON.stringify(payload, null, 2);
}

/** Throws an AppError when the server answer is not an export we know how to save. */
export function parseExport(json: unknown): MyDataExport {
  if (
    typeof json !== 'object' ||
    json === null ||
    (json as Record<string, unknown>).format_version !== 1 ||
    typeof (json as Record<string, unknown>).account !== 'object'
  ) {
    throw new AppError('unknown', { message: 'export_my_data returned an unexpected answer.' });
  }
  return json as MyDataExport;
}

type CountSpec = { label: [one: string, many: string]; count: (payload: MyDataExport) => number };

const length = (value: unknown): number => (Array.isArray(value) ? value.length : 0);

const COUNTED_SECTIONS: CountSpec[] = [
  { label: ['community membership', 'community memberships'], count: (p) => length(p.memberships) },
  { label: ['RSVP', 'RSVPs'], count: (p) => length(p.rsvps) },
  { label: ['attendance record', 'attendance records'], count: (p) => length(p.attendance) },
  { label: ['attendance change', 'attendance changes'], count: (p) => length(p.attendance_changes) },
  { label: ['notification', 'notifications'], count: (p) => length(p.notifications) },
  { label: ['agreement record', 'agreement records'], count: (p) => length(p.consents) },
  { label: ['registered device', 'registered devices'], count: (p) => length(p.push_devices) },
  { label: ['announcement you wrote', 'announcements you wrote'], count: (p) => length(p.authored?.announcements) },
  { label: ['event you organized', 'events you organized'], count: (p) => length(p.authored?.events_organized) },
  {
    label: ['invitation code you created', 'invitation codes you created'],
    count: (p) => length(p.authored?.invitation_codes),
  },
];

const TRUNCATED_LABELS: Record<string, string> = {
  memberships: 'memberships',
  rsvps: 'RSVPs',
  attendance: 'attendance records',
  attendance_changes: 'attendance changes',
  invitation_redemptions: 'invitation redemptions',
  creator_code_redemptions: 'creator code redemptions',
  consents: 'agreement records',
  notifications: 'notifications',
  announcement_reads: 'read announcements',
  push_devices: 'registered devices',
  authored_announcements: 'announcements you wrote',
  events_organized: 'events you organized',
  invitation_codes: 'invitation codes you created',
  invitation_attempts: 'invitation attempts',
  data_export_requests: 'download requests',
};

export type ExportSummary = {
  /** Non-zero sections, e.g. "3 RSVPs". */
  parts: string[];
  /** Friendly names of the lists that were cut at the server's cap. */
  truncated: string[];
};

export function summarizeExport(payload: MyDataExport): ExportSummary {
  const parts: string[] = [];
  for (const spec of COUNTED_SECTIONS) {
    const count = spec.count(payload);
    if (count > 0) parts.push(`${count} ${count === 1 ? spec.label[0] : spec.label[1]}`);
  }
  // About you (birth year, gender, emergency contact, T-shirt size): present only when the person stored something.
  if (payload.extensions?.about_you) parts.push('your About-you details');
  const truncated: string[] = [];
  const flags = (payload.truncated ?? {}) as Record<string, unknown>;
  for (const [key, label] of Object.entries(TRUNCATED_LABELS)) {
    if (flags[key] === true) truncated.push(label);
  }
  return { parts, truncated };
}

function joinList(items: readonly string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/** The success text: what the file holds, and that it must stay private. */
export function exportSuccessMessage(summary: ExportSummary): string {
  const holds =
    summary.parts.length === 0 ? 'your account details' : `your account details, ${joinList(summary.parts)}`;
  return `Your data was prepared. It contains ${holds}. Keep the file private: it holds your personal data.`;
}

/** Shown next to the success text when some lists were cut. Null when nothing was. */
export function exportTruncatedWarning(summary: ExportSummary): string | null {
  if (summary.truncated.length === 0) return null;
  return `The file holds the oldest 5000 entries only for: ${joinList(summary.truncated)}. For a complete copy, contact us.`;
}

/** Friendly text for a failed download. */
export function exportErrorMessage(error: unknown): string {
  const appError = toAppError(error);
  if (appError.code === 'rate_limited') {
    return `You can download your data up to ${EXPORT_LIMIT_PER_HOUR} times per hour. Please try again a little later.`;
  }
  return userMessage(appError.code, appError.field);
}

/** `trainhive-data-<date>.json` and the dateless `trainhive-data.json`: the only files this app writes for an export. */
export const EXPORT_FILE_PATTERN = /^trainhive-data(?:-[A-Za-z0-9-]*)?\.json$/;

/** What `removeExportFiles` needs from a folder entry: the file system boundary, faked in tests. */
export type ExportFolderEntry = { name: string; isFile: boolean; delete: () => void };

/**
 * Deletes the export files (and only those) from a folder listing. Each file
 * is removed on its own: one that cannot be removed is counted and the rest
 * still go. A listing that fails throws, so the caller can report it.
 */
export function removeExportFiles(list: () => readonly ExportFolderEntry[]): {
  removed: number;
  failed: number;
} {
  let removed = 0;
  let failed = 0;
  for (const entry of list()) {
    if (!entry.isFile || !EXPORT_FILE_PATTERN.test(entry.name)) continue;
    try {
      entry.delete();
      removed += 1;
    } catch {
      failed += 1;
    }
  }
  return { removed, failed };
}
