/**
 * View model of Profile -> Privacy: plain-language text per purpose and the
 * state taken from `my_consents`. Pure: no react-native, no clock (dates are
 * formatted by the caller).
 */
import type { ConsentPurpose, MyConsents } from '@/lib/database.types';

import { FEATURES, type LegalFeatures } from '../constants';
import { OPTIONAL_PURPOSES, REQUIRED_PURPOSES } from './consentState';

type PurposeCopy = {
  title: string;
  /** What it is, in one or two plain sentences. */
  description: string;
  /** Title of the confirmation dialog when turning it off. */
  withdrawTitle: string;
  /** What turning it off deletes or stops. */
  withdrawMessage: string;
};

export const PURPOSE_COPY: Record<ConsentPurpose, PurposeCopy> = {
  terms_privacy: {
    title: 'Terms of Use and Privacy Notice',
    description: 'You read and accepted how TrainHive works and how your data is handled.',
    withdrawTitle: '',
    withdrawMessage: '',
  },
  age_16: {
    title: 'Age confirmation',
    description: 'You confirmed that you are at least 16 years old.',
    withdrawTitle: '',
    withdrawMessage: '',
  },
  push_notifications: {
    title: 'Push notifications',
    description:
      'Send reminders and updates to your phone. Your push token and the notification text pass through Expo and Google to reach your device. Everything still appears in notifications (bell icon) without this.',
    withdrawTitle: 'Turn off push notifications?',
    withdrawMessage:
      'We will delete the push tokens saved for your account, so your devices stop receiving push messages. Notifications still appear in notifications (bell icon). You can turn this on again at any time.',
  },
  profile_demographics: {
    title: 'Birth year and gender',
    description:
      'Optional. Used only for statistics: organizers see grouped numbers for groups of 5 or more, never your individual answer. Add or change them in Profile, then About you.',
    withdrawTitle: 'Withdraw consent for birth year and gender?',
    withdrawMessage:
      'The birth year and gender stored for you will be deleted from TrainHive for good, and you will no longer be counted in the grouped statistics. You can give them again later.',
  },
  emergency_contact: {
    title: 'Emergency contact and T-shirt size',
    description:
      'Optional. Visible to the organizers of your communities, for safety at events and for race kits. Tell your contact that you gave their details. Add, change or clear them in Profile, then About you.',
    withdrawTitle: 'Withdraw consent for emergency contact and T-shirt size?',
    withdrawMessage:
      'Your emergency contact and T-shirt size will be deleted from TrainHive for good, and organizers will no longer see them. You can give them again later.',
  },
  workout_logs: {
    title: 'Workout logs',
    description:
      'Optional. Lets you record workouts after events. They are private to you; the community sees only group totals. Workout data can reveal health information.',
    withdrawTitle: 'Withdraw consent for workout logs?',
    withdrawMessage:
      'Your workout logs will be deleted and cannot be restored. You can start a new log later.',
  },
};

export type OptionalConsentRow = {
  purpose: ConsentPurpose;
  title: string;
  description: string;
  /** Current state; this is what the switch shows. */
  enabled: boolean;
  /** Text next to the switch that does not rely on its colour: "On" / "Off". */
  stateLabel: 'On' | 'Off';
  /** ISO time of the latest event (for "since ..."), or null when never recorded. */
  at: string | null;
  withdrawTitle: string;
  withdrawMessage: string;
};

export type RequiredConsentRow = {
  purpose: ConsentPurpose;
  title: string;
  description: string;
  /** ISO time the acceptance was recorded, or null when it is not (or no longer) current. */
  at: string | null;
  /** The accepted text version (combined for the terms), or null. */
  version: string | null;
  /** It is recorded and current. */
  accepted: boolean;
};

/**
 * The optional consents that exist now. A switch for a feature that has not
 * shipped (`FEATURES` flag false) is not shown: a consent with nothing behind
 * it would be a promise the system does not keep.
 */
export function visibleOptionalPurposes(features: LegalFeatures = FEATURES): ConsentPurpose[] {
  return OPTIONAL_PURPOSES.filter((purpose) => {
    if (purpose === 'profile_demographics') return features.demographics;
    if (purpose === 'emergency_contact') return features.emergencyContact;
    if (purpose === 'workout_logs') return features.workoutLogs;
    return true;
  });
}

export function optionalRows(my: MyConsents, features: LegalFeatures = FEATURES): OptionalConsentRow[] {
  return visibleOptionalPurposes(features).map((purpose) => {
    const state = my.consents[purpose];
    const copy = PURPOSE_COPY[purpose];
    const enabled = state.current;
    return {
      purpose,
      title: copy.title,
      description: copy.description,
      enabled,
      stateLabel: enabled ? 'On' : 'Off',
      at: state.at,
      withdrawTitle: copy.withdrawTitle,
      withdrawMessage: copy.withdrawMessage,
    };
  });
}

export function requiredRows(my: MyConsents): RequiredConsentRow[] {
  return REQUIRED_PURPOSES.map((purpose) => {
    const state = my.consents[purpose];
    const copy = PURPOSE_COPY[purpose];
    const accepted = state.current;
    return {
      purpose,
      title: copy.title,
      description: copy.description,
      at: accepted ? state.at : null,
      version: accepted ? state.document_version : null,
      accepted,
    };
  });
}

/** "terms:1|privacy:2" -> "Terms version 1, Privacy Notice version 2". Anything else is shown as is. */
export function describeTermsVersion(version: string | null): string | null {
  if (version === null) return null;
  const match = /^terms:([A-Za-z0-9._-]+)\|privacy:([A-Za-z0-9._-]+)$/.exec(version);
  if (!match) return `Version ${version}`;
  return `Terms version ${match[1]}, Privacy Notice version ${match[2]}`;
}

/** Spoken label for a switch: includes the title and the state so it never relies on colour. */
export function switchLabel(row: Pick<OptionalConsentRow, 'title' | 'stateLabel'>): string {
  return `${row.title}: ${row.stateLabel}`;
}
