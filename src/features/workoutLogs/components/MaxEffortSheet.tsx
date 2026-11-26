import { useState } from 'react';
import { AccessibilityInfo, ScrollView, View } from 'react-native';

import { ResponsiveModal } from '@/features/shell/components/ResponsiveModal';
import type { MaxEffortCandidate } from '@/lib/database.types';
import { reportError } from '@/lib/logger';
import { Banner, Button, Card, EmptyState, ErrorState, LoadingState, Text, useTheme } from '@/ui';

import {
  MAX_EFFORT_INTRO,
  MAX_EFFORT_NO_CONSENT,
  MAX_EFFORT_QUESTION,
  candidateId,
  candidateRecordNote,
  candidateTitle,
  isConfirmedAsShown,
  maxEffortErrorMessage,
  newRecordMessage,
} from '../domain/personalRecords';
import { formatWeight } from '../domain/workoutLog';
import { useConfirmMaxEffort, useMaxEffortCandidates, type MaxEffortAnswer } from '../hooks/useWorkoutLogs';

/**
 * "Was this a maximal effort?" for the qualifying sets of a strength log (record lifts, 1-3 reps).
 * Opened after a save when a set has no answer yet, and later from the log screen. Yes stores the
 * confirmation (the server decides whether it is a record); No stores nothing, or removes an
 * earlier Yes.
 */
export function MaxEffortSheet({
  sessionId,
  visible,
  onClose,
  onShowRecords,
}: {
  sessionId: string;
  visible: boolean;
  onClose: () => void;
  onShowRecords: () => void;
}) {
  const { spacing } = useTheme();
  const query = useMaxEffortCandidates(sessionId, visible);
  const confirm = useConfirmMaxEffort(sessionId);
  // Answers that need no request ("No" to a set never confirmed) and the celebrations, for this opening.
  const [declined, setDeclined] = useState<ReadonlySet<string>>(() => new Set());
  const [records, setRecords] = useState<ReadonlySet<string>>(() => new Set());
  const [pending, setPending] = useState<string | null>(null);
  const [problems, setProblems] = useState<Readonly<Record<string, string>>>({});

  const close = () => {
    if (pending !== null) return;
    setDeclined(new Set());
    setRecords(new Set());
    setProblems({});
    onClose();
  };

  const answer = (candidate: MaxEffortCandidate, confirmed: boolean) => {
    const id = candidateId(candidate);
    if (pending !== null) return;
    setProblems((current) => {
      const next = { ...current };
      delete next[id];
      return next;
    });
    if (!confirmed && !candidate.confirmed) {
      setDeclined((current) => new Set(current).add(id));
      return;
    }
    const payload: MaxEffortAnswer = {
      lift: candidate.lift,
      reps: candidate.reps,
      // Removing: the server removes the confirmation of this lift x reps whatever its weight.
      weightKg: confirmed ? candidate.weight_kg : (candidate.confirmed_weight_kg ?? candidate.weight_kg),
      confirmed,
    };
    setPending(id);
    confirm.mutate(payload, {
      onSuccess: (result) => {
        setDeclined((current) => {
          const next = new Set(current);
          if (result.confirmed) next.delete(id);
          else next.add(id);
          return next;
        });
        setRecords((current) => {
          const next = new Set(current);
          if (result.confirmed && result.is_new_record) next.add(id);
          else next.delete(id);
          return next;
        });
        if (result.confirmed && result.is_new_record) {
          AccessibilityInfo.announceForAccessibility(newRecordMessage(candidate));
        }
      },
      onError: (error) => setProblems((current) => ({ ...current, [id]: maxEffortErrorMessage(error) })),
      onSettled: () => setPending(null),
    });
  };

  let body;
  if (query.isPending) {
    body = <LoadingState message="Loading your sets" />;
  } else if (!query.data) {
    body = (
      <ErrorState
        title="Could not load your sets"
        message={maxEffortErrorMessage(query.error)}
        onRetry={() => {
          query.refetch().catch((error: unknown) => reportError('workoutLogs.candidatesRetry', error));
        }}
      />
    );
  } else if (query.data.candidates.length === 0) {
    body = (
      <EmptyState
        title="No sets to ask about"
        message="Only sets of 1, 2 or 3 reps with a weight of Deadlift, Bench press, Back squat, Front squat, Strict press or Push press can be a lift record."
      />
    );
  } else {
    const data = query.data;
    body = (
      <View style={{ gap: spacing.md }}>
        <Text color="textMuted">{MAX_EFFORT_INTRO}</Text>
        {data.has_consent ? null : <Banner tone="info" message={MAX_EFFORT_NO_CONSENT} />}
        {query.isError ? (
          <Banner tone="warning" message={`${maxEffortErrorMessage(query.error)} Showing the sets that loaded.`} />
        ) : null}
        {data.candidates.map((candidate) => {
          const id = candidateId(candidate);
          return (
            <CandidateCard
              key={id}
              candidate={candidate}
              declined={declined.has(id)}
              newRecord={records.has(id) && isConfirmedAsShown(candidate)}
              pending={pending === id}
              busy={pending !== null}
              canConfirm={data.has_consent}
              problem={problems[id] ?? null}
              onAnswer={(confirmed) => answer(candidate, confirmed)}
            />
          );
        })}
      </View>
    );
  }

  return (
    <ResponsiveModal visible={visible} onClose={close} variant="sheet" kind="panel">
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.sm }}>
        <Text variant="heading" style={{ flex: 1 }}>
          Max efforts
        </Text>
        <Button label="Done" variant="ghost" size="sm" onPress={close} disabled={pending !== null} />
      </View>
      <ScrollView contentContainerStyle={{ gap: spacing.md, paddingBottom: spacing.lg }} keyboardShouldPersistTaps="handled">
        {body}
        {records.size > 0 ? (
          <Button
            label="See personal bests"
            variant="secondary"
            icon="trophy"
            disabled={pending !== null}
            onPress={() => {
              close();
              onShowRecords();
            }}
          />
        ) : null}
      </ScrollView>
    </ResponsiveModal>
  );
}

function CandidateCard({
  candidate,
  declined,
  newRecord,
  pending,
  busy,
  canConfirm,
  problem,
  onAnswer,
}: {
  candidate: MaxEffortCandidate;
  declined: boolean;
  newRecord: boolean;
  pending: boolean;
  busy: boolean;
  canConfirm: boolean;
  problem: string | null;
  onAnswer: (confirmed: boolean) => void;
}) {
  const { spacing } = useTheme();
  const title = candidateTitle(candidate);
  const confirmedAsShown = isConfirmedAsShown(candidate);
  const confirmedOther = candidate.confirmed && !confirmedAsShown;

  let status: string | null = null;
  if (confirmedAsShown) status = 'You confirmed this as a maximal effort.';
  else if (declined) status = 'Not a maximal effort. It does not count as a record.';
  else if (confirmedOther && candidate.confirmed_weight_kg !== null) {
    status = `You confirmed ${formatWeight(candidate.confirmed_weight_kg)} kg earlier. Is ${formatWeight(candidate.weight_kg)} kg your maximal effort now?`;
  }

  return (
    <Card style={{ gap: spacing.sm }}>
      <View accessible accessibilityLabel={`${title}. ${MAX_EFFORT_QUESTION} ${candidateRecordNote(candidate)}${status ? ` ${status}` : ''}`}>
        <Text variant="label">{title}</Text>
        <Text>{MAX_EFFORT_QUESTION}</Text>
        <Text variant="caption" color="textMuted">
          {candidateRecordNote(candidate)}
        </Text>
        {status ? (
          <Text variant="caption" color={confirmedAsShown ? 'success' : 'textMuted'} style={{ marginTop: spacing.xs }}>
            {status}
          </Text>
        ) : null}
      </View>
      {newRecord ? <Banner tone="success" title="New record!" message={newRecordMessage(candidate)} /> : null}
      {problem ? <Banner tone="error" message={problem} /> : null}
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm }}>
        {confirmedAsShown ? (
          <Button
            label="No, it was not"
            variant="ghost"
            size="sm"
            loading={pending}
            disabled={busy && !pending}
            accessibilityLabel={`No, ${title} was not a maximal effort`}
            onPress={() => onAnswer(false)}
          />
        ) : declined ? (
          <Button
            label="Change to Yes"
            variant="ghost"
            size="sm"
            loading={pending}
            disabled={!canConfirm || (busy && !pending)}
            accessibilityLabel={`Yes, ${title} was a maximal effort`}
            onPress={() => onAnswer(true)}
          />
        ) : (
          <>
            <Button
              label="Yes"
              size="sm"
              icon="check"
              loading={pending}
              disabled={!canConfirm || (busy && !pending)}
              accessibilityLabel={`Yes, ${title} was a maximal effort`}
              onPress={() => onAnswer(true)}
            />
            <Button
              label="No"
              variant="secondary"
              size="sm"
              disabled={busy}
              accessibilityLabel={`No, ${title} was not a maximal effort`}
              onPress={() => onAnswer(false)}
            />
          </>
        )}
      </View>
    </Card>
  );
}
