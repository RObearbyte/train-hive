import { useLocalSearchParams } from 'expo-router';

import { LegalDocumentScreen } from '@/features/legal/components/LegalDocumentScreen';

export default function LegalDocumentRoute() {
  const { doc } = useLocalSearchParams<{ doc?: string }>();
  return <LegalDocumentScreen doc={doc} />;
}
