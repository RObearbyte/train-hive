import { useRouter, type Href } from 'expo-router';
import { useState } from 'react';
import { Switch, View } from 'react-native';

import { ConfirmDialog } from '@/features/community/components/ConfirmDialog';
import { useCurrentMembership } from '@/features/community/hooks/useCurrentMembership';
import { DeleteAccountFlow } from '@/features/dataRights/components/DeleteAccountFlow';
import { DownloadMyData } from '@/features/dataRights/components/DownloadMyData';
import { usePush } from '@/features/notifications/hooks/PushProvider';
import { deviceTimeZone, formatLongDate, isValidTimeZone } from '@/lib/datetime';
import type { ConsentPurpose } from '@/lib/database.types';
import { userMessage } from '@/lib/errors';
import { Banner, Button, Card, Divider, ErrorState, LoadingState, Screen, Text, useTheme } from '@/ui';

import {
  describeTermsVersion,
  optionalRows,
  requiredRows,
  switchLabel,
  type OptionalConsentRow,
} from '../domain/privacySettings';
import { useMyConsents, useSetConsent } from '../hooks/useConsents';
import { LegalLinks } from './LegalLinks';
import { PrivacyContact } from './PrivacyContact';

function formatWhen(iso: string | null): string | null {
  if (iso === null) return null;
  const zone = deviceTimeZone();
  return formatLongDate(iso, zone !== null && isValidTimeZone(zone) ? zone : 'UTC');
}

function ConsentRow({
  row,
  busy,
  onChange,
}: {
  row: OptionalConsentRow;
  busy: boolean;
  onChange: (value: boolean) => void;
}) {
  const { colors, spacing, minTouchTarget } = useTheme();
  const since = formatWhen(row.enabled ? row.at : null);
  return (
    <View style={{ padding: spacing.lg, gap: spacing.sm, minHeight: minTouchTarget + 12 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.md }}>
        <View style={{ flex: 1 }}>
          <Text variant="label">{row.title}</Text>
        </View>
        {/* The state is also written out, so it never depends on the switch colour. */}
        <Text variant="label" color={row.enabled ? 'success' : 'textMuted'}>
          {row.stateLabel}
        </Text>
        <Switch
          testID={`consent-switch-${row.purpose}`}
          value={row.enabled}
          disabled={busy}
          onValueChange={onChange}
          accessibilityLabel={switchLabel(row)}
          trackColor={{ false: colors.borderStrong, true: colors.primary }}
          thumbColor={colors.surface}
        />
      </View>
      <Text variant="caption" color="textMuted">
        {row.description}
      </Text>
      {since ? (
        <Text variant="caption" color="textMuted">
          {`On since ${since}`}
        </Text>
      ) : null}
    </View>
  );
}

/** Profile -> Privacy: one switch per optional consent, the required ones, the documents and the privacy contact. */
export function PrivacySettingsScreen() {
  const router = useRouter();
  const { spacing } = useTheme();
  const { consents, isLoading, error, refetch } = useMyConsents();
  const set = useSetConsent();
  const push = usePush();
  const { selectCommunity } = useCurrentMembership();
  const [deleting, setDeleting] = useState(false);
  const [withdrawing, setWithdrawing] = useState<OptionalConsentRow | null>(null);
  const [grantError, setGrantError] = useState<string | null>(null);

  const goBack = () => {
    if (router.canGoBack()) router.back();
    else router.replace('/profile' as Href);
  };

  const grant = (purpose: ConsentPurpose) => {
    setGrantError(null);
    set.mutate(
      { purpose, granted: true },
      {
        onSuccess: () => {
          // The system permission is a second gate, asked right after an explicit tap on this switch.
          if (purpose === 'push_notifications') void push.requestPermission();
        },
        onError: (failure) => setGrantError(userMessage(failure.code, failure.field)),
      },
    );
  };

  const confirmWithdraw = () => {
    if (!withdrawing) return;
    set.mutate(
      { purpose: withdrawing.purpose, granted: false },
      { onSuccess: () => setWithdrawing(null) },
    );
  };

  const header = (
    <>
      <View style={{ alignItems: 'flex-start' }}>
        <Button label="Back" variant="ghost" size="sm" icon="chevron-left" onPress={goBack} />
      </View>
      <Text variant="title">Privacy</Text>
    </>
  );

  if (!consents) {
    return (
      <Screen>
        {header}
        {error ? (
          <ErrorState message={userMessage(error.code, error.field)} onRetry={refetch} style={{ flex: 1 }} />
        ) : (
          <LoadingState message="Loading your privacy choices" style={{ flex: 1 }} />
        )}
        {isLoading ? null : <PrivacyContact />}
      </Screen>
    );
  }

  const optional = optionalRows(consents);
  const required = requiredRows(consents);
  const withdrawingNow = set.isPending && set.variables?.granted === false;

  return (
    <Screen scroll>
      {header}
      <Text color="textMuted">
        You decide what TrainHive may do with optional information. You can change your mind at any
        time, and turning something off takes effect immediately.
      </Text>

      {error ? (
        <Banner
          tone="warning"
          message={userMessage(error.code, error.field)}
          action={{ label: 'Try again', onPress: refetch }}
        />
      ) : null}
      {grantError ? <Banner tone="error" message={grantError} /> : null}

      <View style={{ gap: spacing.sm }}>
        <Text variant="heading">Your choices</Text>
        <Card style={{ padding: 0 }}>
          {optional.map((row, index) => (
            <View key={row.purpose}>
              {index > 0 ? <Divider /> : null}
              <ConsentRow
                row={row}
                busy={set.isPending}
                onChange={(value) => {
                  if (value) grant(row.purpose);
                  else setWithdrawing(row);
                }}
              />
            </View>
          ))}
        </Card>
      </View>

      <View style={{ gap: spacing.sm }}>
        <Text variant="heading">Required to use TrainHive</Text>
        <Card style={{ gap: spacing.md }}>
          {required.map((row, index) => (
            <View key={row.purpose} style={{ gap: spacing.xxs }}>
              {index > 0 ? <Divider /> : null}
              <Text variant="label">{row.title}</Text>
              <Text variant="caption" color="textMuted">
                Required to use TrainHive
              </Text>
              <Text variant="caption" color="textMuted">
                {row.accepted
                  ? [
                      row.purpose === 'terms_privacy' ? describeTermsVersion(row.version) : null,
                      formatWhen(row.at) ? `accepted on ${formatWhen(row.at)}` : null,
                    ]
                      .filter((part): part is string => part !== null)
                      .join(', ') || 'Accepted'
                  : 'Not accepted yet'}
              </Text>
            </View>
          ))}
        </Card>
      </View>

      <View style={{ gap: spacing.sm }}>
        <Text variant="heading">Read more</Text>
        <LegalLinks />
      </View>

      <View style={{ gap: spacing.sm }}>
        <Text variant="heading">Your data</Text>
        <Card style={{ gap: spacing.md }}>
          <Text color="textMuted">
            You can get a copy of everything TrainHive holds about you, or delete your account. For
            any other question about your data, contact us.
          </Text>
          <DownloadMyData />
          <PrivacyContact />
        </Card>
      </View>

      <View style={{ gap: spacing.sm }}>
        <Text variant="heading">Delete my account</Text>
        <Card style={{ gap: spacing.sm }}>
          <Text color="textMuted">
            Deleting your account removes your profile, memberships and RSVPs for good. It cannot be
            undone. You will see what is deleted and what stays before anything happens.
          </Text>
          <Button
            label="Delete my account"
            variant="danger"
            icon="trash"
            fullWidth
            accessibilityHint="Opens the steps to delete your account. Nothing is deleted yet."
            onPress={() => setDeleting(true)}
            testID="delete-account-open"
          />
        </Card>
      </View>

      <DeleteAccountFlow
        visible={deleting}
        onClose={() => setDeleting(false)}
        onOpenMembers={(communityId) => {
          // The Members screen shows the active community: make the blocking one active first.
          selectCommunity(communityId);
          setDeleting(false);
          router.push('/members' as Href);
        }}
      />

      <ConfirmDialog
        visible={withdrawing !== null}
        title={withdrawing?.withdrawTitle ?? ''}
        message={withdrawing?.withdrawMessage ?? ''}
        confirmLabel="Turn off"
        cancelLabel="Keep it on"
        destructive
        pending={withdrawingNow}
        error={set.isError && set.variables?.granted === false ? userMessage(set.error.code, set.error.field) : null}
        onConfirm={confirmWithdraw}
        onCancel={() => {
          setWithdrawing(null);
          set.reset();
        }}
      />
    </Screen>
  );
}
