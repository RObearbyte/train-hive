import { useState } from 'react';
import { View } from 'react-native';

import { myRsvpText } from '@/features/trainings/domain/presentation';
import { useMyAnswersState } from '@/features/trainings/hooks/useTrainings';
import type { RsvpResponse, TrainingSession } from '@/lib/database.types';
import { userMessage } from '@/lib/errors';
import { Banner, Icon, RsvpToggle, Text, useTheme } from '@/ui';

import { canChangeRsvp, rsvpBlockedMessage } from '../domain/rsvp';
import { useSetRsvp } from '../hooks/useSetRsvp';

export interface RsvpControlProps {
  session: Pick<
    TrainingSession,
    'id' | 'status' | 'rsvp_deadline' | 'going_count' | 'max_participants'
  >;
  myResponse: RsvpResponse;
  /** For display only: the server decides whether a change is accepted. */
  now: Date;
}

/**
 * "Am I going?" with a one-tap answer. When responses are unavailable it says
 * why instead of showing dead buttons. The change is optimistic; a failure is
 * undone and explained right here.
 */
export function RsvpControl({ session, myResponse, now }: RsvpControlProps) {
  const { spacing } = useTheme();
  const rsvp = useSetRsvp(session.id);
  const [fullNotice, setFullNotice] = useState(false);
  const answers = useMyAnswersState();

  const open = canChangeRsvp(session, now);

  if (!open.allowed) {
    return (
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm }}>
        <Icon name={open.reason === 'closed' ? 'clock' : 'info'} size={18} color="textMuted" />
        <Text variant="label" color="textMuted" style={{ flex: 1 }}>
          {rsvpBlockedMessage(open.reason)}
          {answers.status === 'ready' ? ` ${myRsvpText(myResponse)}.` : ''}
        </Text>
      </View>
    );
  }

  const onChange = (next: RsvpResponse) => {
    rsvp.clearError();
    const check = canChangeRsvp(session, now, { from: myResponse, to: next });
    if (!check.allowed && check.reason === 'full') {
      setFullNotice(true);
      return;
    }
    setFullNotice(false);
    rsvp.submit(myResponse, next);
  };

  // "No answer yet" with live buttons would be a guess while my answers are unknown.
  if (answers.status === 'error') {
    return (
      <Banner
        tone="warning"
        message="We could not load your answers."
        action={{ label: 'Try again', onPress: answers.retry }}
      />
    );
  }

  return (
    <View style={{ gap: spacing.sm }}>
      <RsvpToggle
        value={myResponse}
        onChange={onChange}
        pending={rsvp.isPending}
        disabled={answers.status === 'loading'}
      />
      {fullNotice && !rsvp.error ? (
        <Banner tone="info" message={userMessage('session_full')} />
      ) : null}
      {rsvp.error ? (
        <Banner
          tone="error"
          title="Your answer was not saved"
          message={userMessage(rsvp.error.code, rsvp.error.field)}
          action={{ label: 'Dismiss', onPress: rsvp.clearError }}
        />
      ) : null}
    </View>
  );
}
