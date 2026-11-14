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
    case 'home':
      content = <Path d="M4 11l8-7 8 7v9H4zM10 20v-6h4v6" {...common} />;
      break;
    case 'calendar':
      content = (
        <>
          <Path d="M4 6h16v14H4zM4 10h16M8 3v4M16 3v4" {...common} />
        </>
      );
      break;
    case 'person':
      content = (
        <>
          <Circle cx={12} cy={8} r={4} {...common} />
          <Path d="M4.5 20a7.5 7.5 0 0 1 15 0" {...common} />
        </>
      );
      break;
    case 'people':
      content = (
        <>
          <Circle cx={9} cy={8} r={3.5} {...common} />
          <Path d="M2.5 19.5a6.5 6.5 0 0 1 13 0" {...common} />
          <Path d="M15.5 4.8a3.5 3.5 0 0 1 0 6.4M17.5 13.5a6.5 6.5 0 0 1 4 6" {...common} />
        </>
      );
      break;
    case 'chevron-left':
      content = <Path d="M15 6l-6 6 6 6" {...common} />;
      break;
    case 'map-pin':
      content = (
        <>
          <Path d="M12 21s-6.5-5.7-6.5-11a6.5 6.5 0 0 1 13 0c0 5.3-6.5 11-6.5 11z" {...common} />
          <Circle cx={12} cy={10} r={2.5} {...common} />
        </>
      );
      break;
    case 'edit':
      content = <Path d="M4 20h4L19 9l-4-4L4 16zM13 7l4 4" {...common} />;
      break;
    case 'share':
      content = <Path d="M12 15V4M8 8l4-4 4 4M5 13v7h14v-7" {...common} />;
      break;
    case 'copy':
      content = <Path d="M9 9h11v11H9zM15 9V4H4v11h5" {...common} />;
      break;
    case 'bell':
      content = <Path d="M6 17V11a6 6 0 0 1 12 0v6l2 2H4zM10 21h4" {...common} />;
      break;
    case 'megaphone':
      content = <Path d="M4 10v4h3l9 5V5L7 10zM7 14l1.5 5h2.5l-1-4.5M19 9.5a3.5 3.5 0 0 1 0 5" {...common} />;
      break;
    case 'chart':
      content = <Path d="M4 20h16M7 20v-7M12 20V5M17 20v-10" {...common} />;
      break;
    case 'external-link':
      content = <Path d="M14 4h6v6M20 4l-9 9M18 14v6H4V6h6" {...common} />;
      break;
    case 'trash':
      content = <Path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v6M14 11v6" {...common} />;
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
