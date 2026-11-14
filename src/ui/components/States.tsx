import { ActivityIndicator, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import type { ReactNode } from 'react';

import { useTheme } from '../theme';
import { Button } from './Button';
import { Icon } from './Icon';
import { Text } from './Text';

export interface EmptyStateProps {
  title: string;
  message?: string;
  action?: { label: string; onPress: () => void };
  /** Optional illustration, e.g. a `HexMotif`. */
  illustration?: ReactNode;
  style?: StyleProp<ViewStyle>;
}

export function EmptyState({ title, message, action, illustration, style }: EmptyStateProps) {
  return (
    <View style={[styles.center, style]}>
      {illustration}
      <Text variant="heading" align="center">
        {title}
      </Text>
      {message ? (
        <Text variant="body" color="textMuted" align="center">
          {message}
        </Text>
      ) : null}
      {action ? <Button label={action.label} onPress={action.onPress} variant="primary" /> : null}
    </View>
  );
}

export interface LoadingStateProps {
  message?: string;
  style?: StyleProp<ViewStyle>;
}

export function LoadingState({ message = 'Loading', style }: LoadingStateProps) {
  const { colors } = useTheme();
  return (
    <View
      accessible
      accessibilityRole="progressbar"
      accessibilityLabel={message}
      accessibilityLiveRegion="polite"
      style={[styles.center, style]}
    >
      <ActivityIndicator size="large" color={colors.primary} />
      <Text variant="caption" color="textMuted">
        {message}
      </Text>
    </View>
  );
}

export interface ErrorStateProps {
  message: string;
  title?: string;
  onRetry?: () => void;
  retryLabel?: string;
  style?: StyleProp<ViewStyle>;
}

export function ErrorState({ message, title = 'Something went wrong', onRetry, retryLabel = 'Try again', style }: ErrorStateProps) {
  return (
    <View accessibilityRole="alert" style={[styles.center, style]}>
      <Icon name="alert" size={36} color="danger" />
      <Text variant="heading" align="center">
        {title}
      </Text>
      <Text variant="body" color="textMuted" align="center">
        {message}
      </Text>
      {onRetry ? <Button label={retryLabel} onPress={onRetry} variant="secondary" icon="refresh" /> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  center: { alignItems: 'center', justifyContent: 'center', gap: 12, padding: 24, alignSelf: 'stretch' },
});
