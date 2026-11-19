import { useState } from 'react';
import { View } from 'react-native';

import type { EventKind, TrainingSession } from '@/lib/database.types';
import { Button, Screen, Text, useTheme } from '@/ui';

import { defaultSubtype, kindInfo } from '../domain/events';
import { useSubtypeOptions } from '../hooks/useTrainings';
import { CreateTrainingForm } from './TrainingForm';
import { KindPicker } from './KindPicker';
import { SubtypePicker } from './SubtypePicker';

export interface CreateEventFlowProps {
  communityId: string;
  /** The community's zone: new events are scheduled in it. Must be valid. */
  timezone: string;
  onSaved: (session: TrainingSession) => void;
  /** Leave the flow from its first step. */
  onClose: () => void;
}

type Step = { name: 'kind' } | { name: 'subtype'; kind: EventKind } | { name: 'form'; kind: EventKind; subtype: string };

function SubtypeStep({
  kind,
  initial,
  onBack,
  onContinue,
}: {
  kind: EventKind;
  initial: string;
  onBack: () => void;
  onContinue: (subtype: string) => void;
}) {
  const { spacing } = useTheme();
  const [subtype, setSubtype] = useState(initial);
  const options = useSubtypeOptions(kind, subtype);
  const info = kindInfo(kind);
  return (
    <Screen scroll>
      <View style={{ alignItems: 'flex-start' }}>
        <Button label="Back" variant="ghost" size="sm" icon="chevron-left" onPress={onBack} />
      </View>
      <View style={{ gap: spacing.xs }}>
        <Text variant="title">{`New ${info.label.toLowerCase()}`}</Text>
        <Text color="textMuted">Which type of {info.label.toLowerCase()} is it?</Text>
      </View>
      <SubtypePicker label="Type" options={options} value={subtype} onChange={setSubtype} />
      <Button label="Continue" size="lg" fullWidth onPress={() => onContinue(subtype)} />
    </Screen>
  );
}

/**
 * Create flow: pick a kind (four cards), pick a subtype, then the details form for that kind.
 * Back goes one step up; from the first step it leaves the flow.
 */
export function CreateEventFlow({ communityId, timezone, onSaved, onClose }: CreateEventFlowProps) {
  const { spacing } = useTheme();
  const [step, setStep] = useState<Step>({ name: 'kind' });

  if (step.name === 'form') {
    return (
      <CreateTrainingForm
        communityId={communityId}
        timezone={timezone}
        kind={step.kind}
        subtype={step.subtype}
        onSaved={onSaved}
        onClose={onClose}
      />
    );
  }

  if (step.name === 'subtype') {
    return (
      <SubtypeStep
        kind={step.kind}
        initial={defaultSubtype(step.kind)}
        onBack={() => setStep({ name: 'kind' })}
        onContinue={(subtype) => setStep({ name: 'form', kind: step.kind, subtype })}
      />
    );
  }

  return (
    <Screen scroll>
      <View style={{ alignItems: 'flex-start' }}>
        <Button label="Back" variant="ghost" size="sm" icon="chevron-left" onPress={onClose} />
      </View>
      <View style={{ gap: spacing.xs }}>
        <Text variant="title">New event</Text>
        <Text color="textMuted">What kind of event do you want to create?</Text>
      </View>
      <KindPicker onPick={(kind) => setStep({ name: 'subtype', kind })} />
    </Screen>
  );
}
