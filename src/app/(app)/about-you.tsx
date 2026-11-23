import { useLocalSearchParams } from 'expo-router';

import { AboutYouScreen } from '@/features/aboutYou/components/AboutYouScreen';

/** `/about-you?welcome=1` is the one-time first page (skippable); `/about-you` is Profile, About you. */
export default function AboutYouRoute() {
  const { welcome } = useLocalSearchParams<{ welcome?: string }>();
  return <AboutYouScreen welcome={welcome === '1'} />;
}
