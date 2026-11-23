import { View } from 'react-native';

import { userMessage } from '@/lib/errors';
import { reportError } from '@/lib/logger';
import { Banner, Card, Divider, ErrorState, LoadingState, Text, useTheme } from '@/ui';

import {
  ageBandSection,
  basisLine,
  genderSection,
  suppressionNote,
  type DemographicsSection,
} from '../domain/demographics';
import { useCommunityDemographics } from '../hooks/useOrganizerData';

function Rows({ title, section }: { title: string; section: DemographicsSection }) {
  const { spacing } = useTheme();
  const { rows, insufficientMessage } = section;
  return (
    <View style={{ gap: spacing.xs }}>
      <Text variant="label">{title}</Text>
      {insufficientMessage ? <Text color="textMuted">{insufficientMessage}</Text> : null}
      {rows.map((row, index) => (
        <View key={row.key}>
          {index > 0 ? <Divider /> : null}
          <View
            accessible
            accessibilityLabel={row.accessibilityLabel}
            style={{ flexDirection: 'row', justifyContent: 'space-between', gap: spacing.md, paddingVertical: spacing.sm }}
          >
            <Text>{row.label}</Text>
            <Text color={row.suppressed ? 'textMuted' : 'text'} variant={row.suppressed ? 'caption' : 'label'}>
              {row.value}
            </Text>
          </View>
        </View>
      ))}
    </View>
  );
}

/**
 * Organizers: "Community profile", the approximate age and gender totals the
 * server computes (small groups hidden, rounded, nothing until enough answers). Today's numbers
 * only: no history and no comparison.
 */
export function CommunityProfileCard({ communityId }: { communityId: string | null }) {
  const { spacing } = useTheme();
  const query = useCommunityDemographics(communityId);

  let body;
  if (query.isPending) {
    body = <LoadingState message="Loading the community profile" />;
  } else if (!query.data) {
    body = (
      <ErrorState
        title="Could not load the community profile"
        message={userMessage(query.error.code, query.error.field)}
        onRetry={() => {
          query.refetch().catch((error: unknown) => reportError('aboutYou.demographicsRetry', error));
        }}
      />
    );
  } else {
    const data = query.data;
    body = (
      <View style={{ gap: spacing.lg }}>
        {query.isError ? (
          <Banner tone="warning" message={`${userMessage(query.error.code, query.error.field)} Showing the last numbers that loaded.`} />
        ) : null}
        <Text color="textMuted">{basisLine(data)}</Text>
        <Rows title="Age" section={ageBandSection(data)} />
        <Rows title="Gender" section={genderSection(data)} />
        <Text variant="caption" color="textMuted">
          {suppressionNote(data)}
        </Text>
      </View>
    );
  }

  return (
    <Card style={{ gap: spacing.md }}>
      <Text variant="heading">Community profile</Text>
      <Text color="textMuted">
        Approximate group totals from what members chose to share, shown only once enough members have answered. Nobody is named, and individual answers are never shown.
      </Text>
      {body}
    </Card>
  );
}
