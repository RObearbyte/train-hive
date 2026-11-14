import { StyleSheet, type StyleProp, type ViewStyle } from 'react-native';
import Svg, { Path } from 'react-native-svg';

import { useTheme, type ColorToken } from '../theme';

export interface HexMotifProps {
  /** Hexagon circumradius inside a 360x160 viewBox. */
  cell?: number;
  color?: ColorToken;
  /** Peak stroke opacity; the pattern fades from right to left. */
  opacity?: number;
  style?: StyleProp<ViewStyle>;
}

const VIEW_W = 360;
const VIEW_H = 160;

function hexPath(cx: number, cy: number, r: number): string {
  const pts: string[] = [];
  for (let k = 0; k < 6; k += 1) {
    const angle = (Math.PI / 180) * (60 * k - 30);
    pts.push(`${(cx + r * Math.cos(angle)).toFixed(1)} ${(cy + r * Math.sin(angle)).toFixed(1)}`);
  }
  return `M${pts.join('L')}Z`;
}

/** Purely decorative hexagon lattice for headers and the welcome screen. Hidden from accessibility. */
export function HexMotif({ cell = 20, color = 'primary', opacity = 0.35, style }: HexMotifProps) {
  const { colors } = useTheme();
  const w = Math.sqrt(3) * cell;
  const rowStep = cell * 1.5;
  const hexes: { d: string; o: number; key: string }[] = [];
  for (let j = 0; j * rowStep < VIEW_H + cell; j += 1) {
    for (let i = -1; i * w < VIEW_W + w; i += 1) {
      const cx = i * w + (j % 2) * (w / 2);
      const cy = j * rowStep;
      const fade = Math.max(0, Math.min(1, cx / VIEW_W));
      hexes.push({ d: hexPath(cx, cy, cell - 1.5), o: opacity * fade * fade, key: `${i}:${j}` });
    }
  }
  return (
    <Svg
      pointerEvents="none"
      viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
      preserveAspectRatio="xMaxYMin slice"
      style={[StyleSheet.absoluteFill, style]}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      {hexes.map((h) => (
        <Path
          key={h.key}
          d={h.d}
          fill="none"
          stroke={colors[color]}
          strokeWidth={1.5}
          strokeOpacity={h.o}
          strokeLinejoin="round"
        />
      ))}
    </Svg>
  );
}
