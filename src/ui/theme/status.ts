import type { ColorPalette } from './colors';

/** The display states of an event: seven for trainings (docs/ARCHITECTURE.md section 6) plus two registration states for other kinds. */
export type TrainingDisplayStatus =
  | 'awaiting_minimum'
  | 'minimum_reached'
  | 'finalizing'
  | 'confirmed'
  | 'cancelled_insufficient'
  | 'cancelled_organizer'
  | 'completed'
  | 'registration_open'
  | 'registration_closed';

export const TRAINING_DISPLAY_STATUSES: readonly TrainingDisplayStatus[] = [
  'awaiting_minimum',
  'minimum_reached',
  'finalizing',
  'confirmed',
  'cancelled_insufficient',
  'cancelled_organizer',
  'completed',
  'registration_open',
  'registration_closed',
];

export type IconName =
  | 'circle'
  | 'circle-half'
  | 'clock'
  | 'check'
  | 'check-circle'
  | 'close'
  | 'ban'
  | 'flag'
  | 'info'
  | 'alert'
  | 'plus'
  | 'chevron-right'
  | 'refresh'
  | 'home'
  | 'calendar'
  | 'person'
  | 'people'
  | 'chevron-left'
  | 'map-pin'
  | 'edit'
  | 'share'
  | 'copy'
  | 'bell'
  | 'megaphone'
  | 'chart'
  | 'external-link'
  | 'trash'
  | 'trophy'
  | 'lock';

export type StatusVisual = 'filled' | 'outlined' | 'tinted';

export interface StatusMeta {
  label: string;
  /** Glyph so status is never color-only. */
  icon: IconName;
  visual: StatusVisual;
  /** Dashed outline marks a provisional state. */
  dashed: boolean;
}

export const statusMeta: Record<TrainingDisplayStatus, StatusMeta> = {
  awaiting_minimum: { label: 'Awaiting minimum', icon: 'circle', visual: 'outlined', dashed: false },
  minimum_reached: { label: 'Minimum reached', icon: 'circle-half', visual: 'outlined', dashed: true },
  finalizing: { label: 'Finalizing', icon: 'clock', visual: 'tinted', dashed: false },
  confirmed: { label: 'Confirmed', icon: 'check', visual: 'filled', dashed: false },
  cancelled_insufficient: { label: 'Cancelled: too few', icon: 'close', visual: 'tinted', dashed: false },
  cancelled_organizer: { label: 'Cancelled by organizer', icon: 'ban', visual: 'filled', dashed: false },
  completed: { label: 'Completed', icon: 'flag', visual: 'filled', dashed: false },
  registration_open: { label: 'Registration open', icon: 'plus', visual: 'outlined', dashed: false },
  registration_closed: { label: 'Registration closed', icon: 'lock', visual: 'tinted', dashed: false },
};

export interface StatusColors {
  fg: string;
  bg: string;
  border: string;
}

export type StatusColorMap = Record<TrainingDisplayStatus, StatusColors>;

export function buildStatusColors(c: ColorPalette): StatusColorMap {
  return {
    awaiting_minimum: { fg: c.info, bg: 'transparent', border: c.info },
    minimum_reached: { fg: c.primary, bg: 'transparent', border: c.primary },
    finalizing: { fg: c.warning, bg: c.warningSoft, border: c.warning },
    confirmed: { fg: c.onPrimary, bg: c.primary, border: c.primary },
    cancelled_insufficient: { fg: c.danger, bg: c.dangerSoft, border: c.danger },
    cancelled_organizer: { fg: c.onDanger, bg: c.danger, border: c.danger },
    completed: { fg: c.surface, bg: c.textMuted, border: c.textMuted },
    registration_open: { fg: c.success, bg: 'transparent', border: c.success },
    registration_closed: { fg: c.onPrimarySoft, bg: c.primarySoft, border: c.onPrimarySoft },
  };
}
