import { usePathname } from 'expo-router';
import { Platform, useWindowDimensions } from 'react-native';

import { dialogLayoutFor, layoutFor, usesWideContent, type DialogLayout, type Layout } from '../domain/layout';

/**
 * Wide layouts are a web feature: native keeps the phone layout whatever the
 * window width (tablets, split screen), so this changes nothing on Android and iOS.
 */
function effectiveWidth(width: number): number {
  return Platform.OS === 'web' ? width : 0;
}

/** The layout for the current window and route. */
export function useLayout(): Layout {
  const { width } = useWindowDimensions();
  const pathname = usePathname();
  return layoutFor(effectiveWidth(width), usesWideContent(pathname));
}

/** Centred card or bottom sheet for a dialog or panel. */
export function useDialogLayout(kind: 'dialog' | 'panel' = 'dialog'): DialogLayout {
  const { width } = useWindowDimensions();
  return dialogLayoutFor(effectiveWidth(width), kind);
}
