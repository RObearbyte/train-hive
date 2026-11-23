import { useRouter, type Href } from 'expo-router';
import { useState } from 'react';
import { View } from 'react-native';

import { ConfirmDialog } from '@/features/community/components/ConfirmDialog';
import { KeyboardScreen } from '@/features/onboarding/components/KeyboardScreen';
import { reportError } from '@/lib/logger';
import { Banner, Button, Card, ErrorState, LoadingState, Text, useTheme } from '@/ui';

import { aboutYouErrorMessage } from '../domain/aboutYou';
import { useAboutYouPrompt, useClearAboutYou, useMyAboutYou } from '../hooks/useAboutYou';
import { AboutYouForm } from './AboutYouForm';

const INTRO =
  'Everything here is optional, and TrainHive works fully without it. Nothing is saved until you tap Save, and the two parts below are separate: you can fill in only one.';

/**
 * "About you". `welcome`: the one-time page shown after a person joins or
 * creates their first community (skippable, then remembered on this device).
 * Otherwise it is Profile, then About you, which can be edited at any time.
 */
export function AboutYouScreen({ welcome }: { welcome: boolean }) {
  const router = useRouter();
  const { spacing } = useTheme();
  const query = useMyAboutYou();
  const clear = useClearAboutYou();
  const { markSeen } = useAboutYouPrompt();
  const [notice, setNotice] = useState<string | null>(null);
  const [clearing, setClearing] = useState(false);

  const leave = () => {
    if (router.canGoBack()) router.back();
    else router.replace((welcome ? '/' : '/profile') as Href);
  };

  const finishWelcome = () => {
    void markSeen().finally(leave);
  };

  const header = (
    <>
      {welcome ? null : (
        <View style={{ alignItems: 'flex-start' }}>
          <Button label="Back" variant="ghost" size="sm" icon="chevron-left" onPress={leave} />
        </View>
      )}
      <Text variant="title">About you</Text>
    </>
  );

  if (query.isPending) {
    return (
      <KeyboardScreen>
        {header}
        <LoadingState message="Loading" style={{ flex: 1 }} />
      </KeyboardScreen>
    );
  }
  if (!query.data) {
    return (
      <KeyboardScreen>
        {header}
        <ErrorState
          message={aboutYouErrorMessage(query.error)}
          onRetry={() => {
            query.refetch().catch((error: unknown) => reportError('aboutYou.retry', error));
          }}
          style={{ flex: 1 }}
        />
        {welcome ? <Button label="Skip for now" variant="ghost" fullWidth onPress={finishWelcome} /> : null}
      </KeyboardScreen>
    );
  }

  const data = query.data;

  return (
    <KeyboardScreen>
      {header}
      <Text color="textMuted">{INTRO}</Text>
      {query.isError ? (
        <Banner
          tone="warning"
          message={`${aboutYouErrorMessage(query.error)} Showing the last details that loaded.`}
          action={{
            label: 'Try again',
            onPress: () => {
              query.refetch().catch((error: unknown) => reportError('aboutYou.retry', error));
            },
          }}
        />
      ) : null}
      {notice ? <Banner tone="success" message={notice} /> : null}

      <AboutYouForm
        data={data}
        welcome={welcome}
        onSaved={() => {
          if (welcome) finishWelcome();
          else setNotice('Saved. Your details are up to date.');
        }}
        onNothingToSave={() => {
          if (welcome) finishWelcome();
          else setNotice('Nothing to save: nothing changed.');
        }}
        onSkip={finishWelcome}
      />

      {data.has_data ? (
        <Card style={{ gap: spacing.sm }}>
          <Text variant="heading">Clear my About-you data</Text>
          <Text color="textMuted">
            Deletes the birth year, gender, emergency contact and T-shirt size TrainHive holds for you.
            Your agreements stay as they are, so you can add details again later.
          </Text>
          <Button
            label="Clear my About-you data"
            variant="danger"
            icon="trash"
            fullWidth
            onPress={() => {
              setNotice(null);
              setClearing(true);
            }}
            testID="about-you-clear"
          />
        </Card>
      ) : null}

      <ConfirmDialog
        visible={clearing}
        title="Clear your About-you data?"
        message="Your birth year, gender, emergency contact and T-shirt size will be deleted from TrainHive. Organizers will no longer see them. This cannot be undone, but you can add details again at any time."
        confirmLabel="Clear my data"
        cancelLabel="Keep it"
        destructive
        pending={clear.isPending}
        error={clear.isError ? aboutYouErrorMessage(clear.error) : null}
        onConfirm={() => {
          if (clear.isPending) return;
          clear.mutate(undefined, {
            onSuccess: () => {
              setClearing(false);
              setNotice('Your About-you data was deleted.');
            },
          });
        }}
        onCancel={() => {
          setClearing(false);
          clear.reset();
        }}
      />
    </KeyboardScreen>
  );
}
