import { View } from 'react-native';

import { Banner, Text, useTheme } from '@/ui';

import { DRAFT_BANNER_TEXT, LEGAL_REVIEWED } from '../constants';
import type { LegalBlock, LegalDocument } from '../content';

function Block({ block }: { block: LegalBlock }) {
  const { spacing, colors, radii } = useTheme();
  switch (block.type) {
    case 'paragraph':
      return <Text selectable>{block.text}</Text>;
    case 'list':
      return (
        <View role="list" style={{ gap: spacing.sm }}>
          {block.items.map((item) => (
            <View key={item} role="listitem" style={{ flexDirection: 'row', gap: spacing.sm }}>
              <Text accessibilityElementsHidden importantForAccessibility="no">
                {'•'}
              </Text>
              <Text selectable style={{ flex: 1 }}>
                {item}
              </Text>
            </View>
          ))}
        </View>
      );
    case 'facts':
      return (
        <View
          style={{
            borderWidth: 1,
            borderColor: colors.border,
            borderRadius: radii.md,
            backgroundColor: colors.surface,
          }}
        >
          {block.rows.map((row, index) => (
            <View
              key={row.label}
              style={{
                padding: spacing.md,
                gap: spacing.xxs,
                borderTopWidth: index === 0 ? 0 : 1,
                borderTopColor: colors.border,
              }}
            >
              <Text variant="label" selectable>
                {row.label}
              </Text>
              <Text color="textMuted" selectable>
                {row.value}
              </Text>
            </View>
          ))}
        </View>
      );
  }
}

/**
 * A legal document as readable, selectable text with real headings. Carries a
 * visible draft banner while `LEGAL_REVIEWED` is false.
 */
export function LegalDocumentView({ doc }: { doc: LegalDocument }) {
  const { spacing } = useTheme();
  return (
    <View style={{ gap: spacing.lg }}>
      <View style={{ gap: spacing.xs }}>
        <Text variant="title">{doc.title}</Text>
        <Text variant="caption" color="textMuted">
          {`Version ${doc.version}, last updated ${doc.lastUpdated}`}
        </Text>
      </View>
      {LEGAL_REVIEWED ? null : <Banner tone="warning" message={DRAFT_BANNER_TEXT} />}
      <Text selectable>{doc.intro}</Text>
      {doc.sections.map((section) => (
        <View key={section.id} style={{ gap: spacing.sm }}>
          <Text variant="heading">{section.heading}</Text>
          {section.blocks.map((block, index) => (
            <Block key={`${section.id}-${index}`} block={block} />
          ))}
        </View>
      ))}
    </View>
  );
}
