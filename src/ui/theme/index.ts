import { useColorScheme } from 'react-native';

import { darkColors, lightColors, type ColorPalette } from './colors';
import { buildStatusColors, type StatusColorMap } from './status';
import { elevation, MIN_TOUCH_TARGET, radii, spacing, typography } from './tokens';

export * from './colors';
export * from './status';
export * from './tokens';

export interface Theme {
  scheme: 'light' | 'dark';
  colors: ColorPalette;
  status: StatusColorMap;
  spacing: typeof spacing;
  radii: typeof radii;
  typography: typeof typography;
  elevation: typeof elevation;
  minTouchTarget: number;
}

function makeTheme(scheme: 'light' | 'dark'): Theme {
  const colors = scheme === 'dark' ? darkColors : lightColors;
  return {
    scheme,
    colors,
    status: buildStatusColors(colors),
    spacing,
    radii,
    typography,
    elevation,
    minTouchTarget: MIN_TOUCH_TARGET,
  };
}

export const lightTheme: Theme = makeTheme('light');
export const darkTheme: Theme = makeTheme('dark');

/** Theme driven by the system color scheme. */
export function useTheme(): Theme {
  const scheme = useColorScheme();
  return scheme === 'dark' ? darkTheme : lightTheme;
}
