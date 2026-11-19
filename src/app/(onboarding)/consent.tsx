import { useLocalSearchParams } from 'expo-router';

import { BeforeYouStartScreen } from '@/features/legal/components/BeforeYouStartScreen';

export default function ConsentRoute() {
  const { next } = useLocalSearchParams<{ next?: string }>();
  return <BeforeYouStartScreen next={next} />;
}
