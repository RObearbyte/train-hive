import { usePathname } from 'expo-router';
import { useEffect } from 'react';
import { Platform } from 'react-native';

import { titleForPath } from '../domain/pageTitle';

/** Web only: keeps the browser tab title in step with the current route ("Events · TrainHive"). */
export function useDocumentTitle(): void {
  const pathname = usePathname();
  useEffect(() => {
    if (Platform.OS !== 'web' || typeof document === 'undefined') return;
    document.title = titleForPath(pathname);
  }, [pathname]);
}
