import Svg, { Circle, Path } from 'react-native-svg';

import { useTheme, type ColorToken, type IconName } from '../theme';

export interface IconProps {
  name: IconName;
  size?: number;
  color?: ColorToken | (string & {});
}

/** Decorative glyph. Always pair it with text or an accessible label on the parent. */
export function Icon({ name, size = 20, color = 'text' }: IconProps) {
  const { colors } = useTheme();
  const stroke = color in colors ? colors[color as ColorToken] : color;
  const common = {
    stroke,
    strokeWidth: 2,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    fill: 'none',
  };

  let content;
  switch (name) {
    case 'circle':
      content = <Circle cx={12} cy={12} r={8} {...common} />;
      break;
    case 'circle-half':
      content = (
        <>
          <Circle cx={12} cy={12} r={8} {...common} />
          <Path d="M12 4 A8 8 0 0 1 12 20 Z" fill={stroke} stroke={stroke} strokeWidth={1} />
        </>
      );
      break;
    case 'clock':
      content = (
        <>
          <Circle cx={12} cy={12} r={8} {...common} />
          <Path d="M12 7.5V12l3 2" {...common} />
        </>
      );
      break;
    case 'check':
      content = <Path d="M5 12.5l4.5 4.5L19 7.5" {...common} />;
      break;
    case 'check-circle':
      content = (
        <>
          <Circle cx={12} cy={12} r={9} {...common} />
          <Path d="M8 12.5l3 3 5-6" {...common} />
        </>
      );
      break;
    case 'close':
      content = <Path d="M6 6l12 12M18 6L6 18" {...common} />;
      break;
    case 'ban':
      content = (
        <>
          <Circle cx={12} cy={12} r={8} {...common} />
          <Path d="M6.5 6.5l11 11" {...common} />
        </>
      );
      break;
    case 'flag':
      content = <Path d="M6 21V4M6 4h11l-2 4 2 4H6" {...common} />;
      break;
    case 'info':
      content = (
        <>
          <Circle cx={12} cy={12} r={9} {...common} />
          <Path d="M12 11v5M12 8h.01" {...common} />
        </>
      );
      break;
    case 'alert':
      content = (
        <>
          <Path d="M12 4l9 16H3z" {...common} />
          <Path d="M12 10v4M12 17h.01" {...common} />
        </>
      );
      break;
    case 'plus':
      content = <Path d="M12 5v14M5 12h14" {...common} />;
      break;
    case 'chevron-right':
      content = <Path d="M9 6l6 6-6 6" {...common} />;
      break;
    case 'refresh':
      content = <Path d="M20 12a8 8 0 1 1-2.3-5.7M20 4v5h-5" {...common} />;
      break;
  }

  return (
    <Svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      {content}
    </Svg>
  );
}
