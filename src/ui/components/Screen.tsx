import { RefreshControl, ScrollView, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { SafeAreaView, type Edge } from 'react-native-safe-area-context';
import type { ReactNode } from 'react';

import { useTheme } from '../theme';

export interface ScreenProps {
  children: ReactNode;
  /** Wrap content in a ScrollView. */
  scroll?: boolean;
  /** Adds horizontal/vertical padding (default true). */
  padded?: boolean;
  /** Pull-to-refresh; only applies when `scroll` is set. */
  onRefresh?: () => void;
  refreshing?: boolean;
  /** Safe-area edges to respect. Defaults to all; pass fewer when a navigator header/tab bar already covers them. */
  edges?: readonly Edge[];
  contentContainerStyle?: StyleProp<ViewStyle>;
  testID?: string;
}

export function Screen({
  children,
  scroll = false,
  padded = true,
  onRefresh,
  refreshing = false,
  edges,
  contentContainerStyle,
  testID,
}: ScreenProps) {
  const { colors, spacing } = useTheme();
  const padding: ViewStyle = padded ? { padding: spacing.lg, gap: spacing.lg } : {};

  return (
    <SafeAreaView testID={testID} edges={edges} style={[styles.flex, { backgroundColor: colors.background }]}>
      {scroll ? (
        <ScrollView
          style={styles.flex}
          contentContainerStyle={[styles.grow, padding, contentContainerStyle]}
          keyboardShouldPersistTaps="handled"
          refreshControl={
            onRefresh ? (
              <RefreshControl
                refreshing={refreshing}
                onRefresh={onRefresh}
                tintColor={colors.primary}
                colors={[colors.primary]}
              />
            ) : undefined
          }
        >
          {children}
        </ScrollView>
      ) : (
        <View style={[styles.flex, padding, contentContainerStyle]}>{children}</View>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  grow: { flexGrow: 1 },
});
