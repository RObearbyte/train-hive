import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

import { useTheme, type ColorToken, type IconName } from '../theme';
import { Button } from './Button';
import { Icon } from './Icon';
import { Text } from './Text';

export type BannerTone = 'info' | 'success' | 'warning' | 'error';

export interface BannerProps {
  tone?: BannerTone;
  title?: string;
  message: string;
  action?: { label: string; onPress: () => void };
  style?: StyleProp<ViewStyle>;
}

const toneConfig: Record<BannerTone, { accent: ColorToken; soft: ColorToken; icon: IconName; spoken: string }> = {
  info: { accent: 'info', soft: 'infoSoft', icon: 'info', spoken: 'Information' },
  success: { accent: 'success', soft: 'successSoft', icon: 'check-circle', spoken: 'Success' },
  warning: { accent: 'warning', soft: 'warningSoft', icon: 'alert', spoken: 'Warning' },
  error: { accent: 'danger', soft: 'dangerSoft', icon: 'close', spoken: 'Error' },
};

export function Banner({ tone = 'info', title, message, action, style }: BannerProps) {
  const { colors, radii, spacing } = useTheme();
  const cfg = toneConfig[tone];
  return (
    <View
      accessible={!action}
      accessibilityRole={tone === 'error' ? 'alert' : undefined}
      accessibilityLiveRegion={tone === 'error' ? 'assertive' : 'polite'}
      accessibilityLabel={action ? undefined : `${cfg.spoken}. ${title ? `${title}. ` : ''}${message}`}
      style={[
        styles.base,
        {
          backgroundColor: colors[cfg.soft],
          borderColor: colors[cfg.accent],
          borderRadius: radii.md,
          padding: spacing.md,
          gap: spacing.md,
        },
        style,
      ]}
    >
      <View style={styles.row}>
        <Icon name={cfg.icon} size={22} color={cfg.accent} />
        <View style={styles.body}>
          {title ? <Text variant="label">{title}</Text> : null}
          <Text variant="body">{message}</Text>
        </View>
      </View>
      {action ? <Button label={action.label} onPress={action.onPress} variant="secondary" size="sm" /> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  base: { borderWidth: 1, alignSelf: 'stretch' },
  row: { flexDirection: 'row', alignItems: 'flex-start', gap: 10 },
  body: { flex: 1, gap: 2 },
});
