import { useRouter, type Href } from 'expo-router';
import { View } from 'react-native';

import { ContentColumn } from '@/features/shell/components/ContentColumn';
import { useLayout } from '@/features/shell/hooks/useLayout';
import { Button, EmptyState, Screen } from '@/ui';

import { legalConfig } from '../config';
import { parseLegalDocKind } from '../constants';
import { buildLegalDocument } from '../content';
import { LegalDocumentView } from './LegalDocumentView';

/** Readable column on wide web windows; full width on phones. */
const READING_WIDTH = 760;

/**
 * A legal document as a page. Open to everyone (no account needed): reachable
 * from onboarding, the Privacy screen and the web footer. `doc` is the route
 * parameter and is checked against the two known documents.
 */
export function LegalDocumentScreen({ doc }: { doc: unknown }) {
  const router = useRouter();
  const layout = useLayout();
  const kind = parseLegalDocKind(Array.isArray(doc) ? doc[0] : doc);

  const goBack = () => {
    if (router.canGoBack()) router.back();
    else router.replace('/' as Href);
  };

  return (
    <ContentColumn maxWidth={layout.mode === 'wide' ? READING_WIDTH : null}>
      <Screen scroll>
        <View style={{ alignItems: 'flex-start' }}>
          <Button label="Back" variant="ghost" size="sm" icon="chevron-left" onPress={goBack} />
        </View>
        {kind === null ? (
          <EmptyState title="Document not found" message="Open the Privacy Notice or the Terms of Use from the previous screen." />
        ) : (
          <LegalDocumentView doc={buildLegalDocument(kind, legalConfig)} />
        )}
      </Screen>
    </ContentColumn>
  );
}
