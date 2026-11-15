import { useState } from 'react';
import { FlatList, View } from 'react-native';

import { useCommunityMembers } from '@/features/community/hooks/useCommunityMembers';
import { toAppError, userMessage } from '@/lib/errors';
import type { AttendanceSheetEntry } from '@/lib/database.types';
import { reportError } from '@/lib/logger';
import {
  Avatar,
  Banner,
  Button,
  EmptyState,
  ErrorState,
  ListItem,
  LoadingState,
  Text,
  TextField,
  useTheme,
} from '@/ui';

import { walkInCandidates } from '../domain/sheet';
import { useAddWalkIn } from '../hooks/useAttendanceMutations';
import { SheetModal } from './SheetModal';

export interface AddAttendeeModalProps {
  visible: boolean;
  onClose: () => void;
  sessionId: string;
  communityId: string | null;
  /** Everyone already on the sheet: they cannot be added again. */
  entries: readonly AttendanceSheetEntry[];
}

/**
 * Search the community's active members and add one who did not RSVP as a
 * walk-in (recorded as Present). The panel stays open so several people can be
 * added in a row; each addition drops out of the list.
 */
export function AddAttendeeModal({
  visible,
  onClose,
  sessionId,
  communityId,
  entries,
}: AddAttendeeModalProps) {
  const { spacing } = useTheme();
  const members = useCommunityMembers(communityId, visible);
  const addWalkIn = useAddWalkIn(sessionId);
  const [search, setSearch] = useState('');
  const [lastAdded, setLastAdded] = useState<string | null>(null);

  const candidates = walkInCandidates(members.data ?? [], entries, search);
  const failure = addWalkIn.error ? userMessage(addWalkIn.error.code, addWalkIn.error.field) : null;

  const close = () => {
    setSearch('');
    setLastAdded(null);
    addWalkIn.reset();
    onClose();
  };

  let list;
  if (members.isPending) {
    list = <LoadingState message="Loading members" style={{ flex: 1 }} />;
  } else if (members.isError && !members.data) {
    list = (
      <ErrorState
        title="Could not load members"
        message={userMessage(toAppError(members.error).code)}
        onRetry={() => {
          members.refetch().catch((error: unknown) => reportError('attendance.members', error));
        }}
        style={{ flex: 1 }}
      />
    );
  } else if (candidates.length === 0) {
    list = (
      <EmptyState
        title={search.trim() === '' ? 'Everyone is on the list' : 'No match'}
        message={
          search.trim() === ''
            ? 'Every active member is already on this attendance sheet.'
            : 'No member without a record matches that name.'
        }
        style={{ flex: 1 }}
      />
    );
  } else {
    list = (
      <FlatList
        data={candidates}
        keyExtractor={(member) => member.userId}
        keyboardShouldPersistTaps="handled"
        renderItem={({ item }) => (
          <ListItem
            title={item.displayName}
            subtitle="Add as walk-in (Present)"
            leading={<Avatar name={item.displayName} size={36} />}
            trailing={<Text variant="label" color="primary">Add</Text>}
            accessibilityLabel={`Add ${item.displayName} as a walk-in`}
            onPress={
              addWalkIn.isPending
                ? undefined
                : () => {
                    setLastAdded(null);
                    addWalkIn.mutate(
                      { userId: item.userId, displayName: item.displayName },
                      { onSuccess: () => setLastAdded(item.displayName) },
                    );
                  }
            }
          />
        )}
      />
    );
  }

  return (
    <SheetModal visible={visible} title="Add attendee" onClose={close}>
      <Text color="textMuted">
        For members who came without saying they were going. They are recorded as Present.
      </Text>
      <TextField
        label="Search members"
        value={search}
        onChangeText={setSearch}
        autoCapitalize="none"
        autoCorrect={false}
        returnKeyType="search"
      />
      {failure !== null ? (
        <Banner
          tone="error"
          title="Not added"
          message={failure}
          action={{ label: 'Dismiss', onPress: addWalkIn.reset }}
        />
      ) : null}
      {lastAdded !== null && failure === null ? (
        <Banner tone="success" message={`${lastAdded} was added as Present.`} />
      ) : null}
      {addWalkIn.isPending ? <Text variant="caption" color="textMuted">Adding</Text> : null}
      <View style={{ flex: 1, gap: spacing.sm }}>{list}</View>
      <Button label="Done" onPress={close} fullWidth />
    </SheetModal>
  );
}
