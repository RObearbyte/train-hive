import { useRouter } from 'expo-router';
import { View } from 'react-native';

import { Button, useTheme } from '@/ui';

import { LEGAL_DOC_TITLES, type LegalDocKind } from '../constants';
import { legalHref } from './legalHref';

/** "Read the Privacy Notice" / "Read the Terms of Use": open the documents in the app. */
export function LegalLinks({ kinds = ['privacy', 'terms'] }: { kinds?: readonly LegalDocKind[] }) {
  const router = useRouter();
  const { spacing } = useTheme();
  return (
    <View style={{ gap: spacing.xs, alignItems: 'flex-start' }}>
      {kinds.map((kind) => (
        <Button
          key={kind}
          label={`Read the ${LEGAL_DOC_TITLES[kind]}`}
          variant="ghost"
          size="sm"
          icon="external-link"
          accessibilityHint="Opens the document in the app"
          onPress={() => router.push(legalHref(kind))}
        />
      ))}
    </View>
  );
}
