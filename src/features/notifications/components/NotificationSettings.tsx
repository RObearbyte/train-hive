import { Switch, View } from 'react-native';

import { userMessage } from '@/lib/errors';
import { Banner, Card, Divider, ErrorState, LoadingState, Text, useTheme } from '@/ui';

import { pushStateView } from '../domain/pushState';
import type { NotificationPrefs } from '../domain/preferencesCache';
import { usePush } from '../hooks/PushProvider';
import {
  useNotificationPreferences,
  useSetNotificationPreferences,
} from '../hooks/useNotificationPreferences';

type Toggle = { field: keyof NotificationPrefs; label: string; hint: string };

const TOGGLES: Toggle[] = [
  {
    field: 'training_updates',
    label: 'Training updates',
    hint: 'New, changed, confirmed and cancelled trainings',
  },
  { field: 'training_reminders', label: 'Reminders', hint: 'A day and two hours before a training' },
  { field: 'announcements', label: 'Announcements', hint: 'Messages from your organizers' },
];

function ToggleRow({
  label,
  hint,
  value,
  disabled,
  onChange,
}: {
  label: string;
  hint: string;
  value: boolean;
  disabled?: boolean;
  onChange: (value: boolean) => void;
}) {
  const { colors, spacing, minTouchTarget } = useTheme();
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.md,
        minHeight: minTouchTarget + 12,
        paddingVertical: spacing.sm,
        paddingHorizontal: spacing.lg,
      }}
    >
      <View style={{ flex: 1, gap: spacing.xxs }}>
        <Text>{label}</Text>
        <Text variant="caption" color="textMuted">
          {hint}
        </Text>
      </View>
      <Switch
        value={value}
        disabled={disabled}
        onValueChange={onChange}
        accessibilityLabel={label}
        trackColor={{ false: colors.borderStrong, true: colors.primary }}
        thumbColor={colors.surface}
      />
    </View>
  );
}

/**
 * Profile -> Notifications: this device's push state (with the action that
 * fixes it) and the push preferences. In-app notifications are always kept,
 * whatever is chosen here.
 */
export function NotificationSettings() {
  const { spacing } = useTheme();
  const push = usePush();
  const view = pushStateView(push.kind);
  const preferences = useNotificationPreferences();
  const save = useSetNotificationPreferences();
  const { prefs } = preferences;

  const runAction = () => {
    if (view.action === 'enable') void push.enable();
    else if (view.action === 'open_settings') push.openSettings();
    else if (view.action === 'retry') push.retry();
  };

  return (
    <View style={{ gap: spacing.sm }}>
      <Text variant="heading">Notifications</Text>
      <Banner
        tone={view.tone}
        title={view.title}
        message={view.description}
        action={
          view.action && view.actionLabel ? { label: view.actionLabel, onPress: runAction } : undefined
        }
      />
      {push.enableError ? <Banner tone="error" message={push.enableError} /> : null}

      {preferences.isLoading ? (
        <LoadingState message="Loading notification settings" />
      ) : preferences.error && !prefs ? (
        <ErrorState
          message={userMessage(preferences.error.code, preferences.error.field)}
          onRetry={preferences.refetch}
        />
      ) : prefs ? (
        <>
          {save.error ? (
            <Banner tone="error" message={userMessage(save.error.code, save.error.field)} />
          ) : null}
          <Card>
            <ToggleRow
              label="Push notifications"
              hint="Turn off to stop all push messages. They still appear in Activity."
              value={prefs.push_enabled}
              onChange={(value) => save.mutate({ push_enabled: value })}
            />
            {TOGGLES.map((toggle) => (
              <View key={toggle.field}>
                <Divider />
                <ToggleRow
                  label={toggle.label}
                  hint={toggle.hint}
                  value={prefs[toggle.field]}
                  disabled={!prefs.push_enabled}
                  onChange={(value) => save.mutate({ [toggle.field]: value })}
                />
              </View>
            ))}
          </Card>
          <Text variant="caption" color="textMuted">
            These choices only affect push messages. Everything is always kept in the Activity tab.
          </Text>
        </>
      ) : null}
    </View>
  );
}
