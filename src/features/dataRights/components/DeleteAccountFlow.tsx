import { useEffect, useReducer, useState } from 'react';
import { ScrollView, View } from 'react-native';

import { ResponsiveModal } from '@/features/shell/components/ResponsiveModal';
import { userMessage } from '@/lib/errors';
import { Banner, Button, Card, ErrorState, Icon, LoadingState, Text, TextField, useTheme } from '@/ui';

import {
  BLOCKED_ADVICE,
  DELETE_CONFIRM_WORD,
  INITIAL_DELETION_STATE,
  blockerSentence,
  canSubmitDeletion,
  deletionReducer,
} from '../domain/deletion';
import { BLOCKED_BEHIND_GATE_ADVICE } from '@/features/legal/domain/termsUpdate';
import { DeletionBlockedError, useDeleteAccount, useDeletionBlockers } from '../hooks/useDeleteAccount';
import { DownloadMyData } from './DownloadMyData';

export interface DeleteAccountFlowProps {
  visible: boolean;
  onClose: () => void;
  /**
   * Opens the Members screen for a community the person is the last organizer of. Omitted where
   * that screen is out of reach (the updated-terms screen): the flow then explains the way round.
   */
  onOpenMembers?: (communityId: string) => void;
}

const DELETED = [
  'Your profile and name',
  'Your memberships in every community',
  'Your RSVPs, notifications and read receipts',
  'The devices registered for push notifications',
  'Your agreements and privacy choices',
];

const KEPT = [
  'Attendance counts stay, without your name or any link to you, so past statistics stay correct. In a very small community these counts can still point to a person.',
  'Announcements you published stay visible to your community; they are no longer linked to you.',
  'Events you organized stay without an organizer.',
];

function Bullets({ items }: { items: readonly string[] }) {
  const { spacing } = useTheme();
  return (
    <View style={{ gap: spacing.xs }}>
      {items.map((item) => (
        <View key={item} style={{ flexDirection: 'row', gap: spacing.sm }}>
          <Text color="textMuted">{'•'}</Text>
          <Text style={{ flex: 1 }}>{item}</Text>
        </View>
      ))}
    </View>
  );
}

/**
 * Profile -> Privacy -> "Delete my account". First asks the server what stands
 * in the way (the last organizer of a community cannot leave it without
 * handing over), then explains what is deleted and what stays, then asks for
 * the word DELETE. The server authorizes and enforces everything again.
 */
export function DeleteAccountFlow({ visible, onClose, onOpenMembers }: DeleteAccountFlowProps) {
  const { spacing } = useTheme();
  const blockersQuery = useDeletionBlockers(visible);
  const deletion = useDeleteAccount();
  const [state, dispatch] = useReducer(deletionReducer, INITIAL_DELETION_STATE);
  const [typed, setTyped] = useState('');

  const data = blockersQuery.data;
  useEffect(() => {
    if (visible && data && state.step === 'checking') dispatch({ type: 'blockers_loaded', blockers: data });
  }, [visible, data, state.step]);

  const close = () => {
    if (deletion.isPending) return;
    dispatch({ type: 'reset' });
    setTyped('');
    deletion.reset();
    onClose();
  };

  const submit = () => {
    if (!canSubmitDeletion(state, typed, deletion.isPending)) return;
    deletion.mutate(undefined, {
      onError: (error) => {
        if (error instanceof DeletionBlockedError) {
          dispatch({ type: 'blocked_by_server', communities: error.communities });
          setTyped('');
          deletion.reset();
        }
      },
    });
  };

  const deleteWith = state.blockers?.deleted_with_account ?? [];

  let body;
  if (state.step === 'checking') {
    body = blockersQuery.isError ? (
      <ErrorState
        title="Could not check your account"
        message={userMessage(blockersQuery.error.code, blockersQuery.error.field)}
        onRetry={() => {
          void blockersQuery.refetch();
        }}
      />
    ) : (
      <LoadingState message="Checking your account" />
    );
  } else if (state.step === 'blocked') {
    const blocked = state.blockers?.last_organizer ?? [];
    body = (
      <>
        <Text variant="title" accessibilityRole="header">
          You cannot delete your account yet
        </Text>
        <Banner
          tone="warning"
          message="A community needs at least one organizer. Hand over first, then come back here."
        />
        {blocked.map((community) => (
          <Card key={community.community_id} style={{ gap: spacing.sm }}>
            <Text variant="label">{community.name}</Text>
            <Text>{blockerSentence(community)}</Text>
            {onOpenMembers ? (
              <Button
                label="Open members"
                variant="secondary"
                size="sm"
                accessibilityLabel={`Open the members of ${community.name}`}
                onPress={() => onOpenMembers(community.community_id)}
              />
            ) : null}
          </Card>
        ))}
        <Text color="textMuted">{BLOCKED_ADVICE}</Text>
        {onOpenMembers ? null : <Text color="textMuted">{BLOCKED_BEHIND_GATE_ADVICE}</Text>}
        <Button label="Close" variant="ghost" fullWidth onPress={close} />
      </>
    );
  } else if (state.step === 'explain') {
    body = (
      <>
        <Text variant="title" accessibilityRole="header">
          Delete your account?
        </Text>
        <Banner
          tone="warning"
          title="This cannot be undone"
          message="Your account is anonymous and lives on this device. Once it is deleted, there is no way to get it back."
        />
        {deleteWith.length > 0 ? (
          <Banner
            tone="error"
            title="Communities deleted with your account"
            message={`You are the only member of ${deleteWith.map((c) => c.name).join(', ')}. ${deleteWith.length === 1 ? 'It' : 'They'} will be deleted with your account, with all events, announcements and history.`}
          />
        ) : null}
        <View style={{ gap: spacing.sm }}>
          <Text variant="heading">What is deleted</Text>
          <Bullets items={DELETED} />
        </View>
        <View style={{ gap: spacing.sm }}>
          <Text variant="heading">What stays, without your name</Text>
          <Bullets items={KEPT} />
        </View>
        <View style={{ gap: spacing.sm }}>
          <Text variant="heading">Want a copy first?</Text>
          <Text color="textMuted">
            Download your data now. After the deletion it is gone, and so is the option to download it.
          </Text>
          <DownloadMyData />
        </View>
        <Button label="Continue" variant="secondary" fullWidth onPress={() => dispatch({ type: 'next' })} />
        <Button label="Cancel" variant="ghost" fullWidth onPress={close} />
      </>
    );
  } else {
    const failure = deletion.error && !(deletion.error instanceof DeletionBlockedError) ? deletion.error : null;
    const offline = failure?.code === 'network_error';
    body = (
      <>
        <Text variant="title" accessibilityRole="header">
          Confirm deletion
        </Text>
        <View style={{ flexDirection: 'row', gap: spacing.sm, alignItems: 'center' }}>
          <Icon name="trash" size={22} color="danger" />
          <Text variant="label" color="danger" style={{ flex: 1 }}>
            This permanently deletes your account.
          </Text>
        </View>
        {deleteWith.length > 0 ? (
          <Text color="textMuted">{`Also deleted: ${deleteWith.map((c) => c.name).join(', ')}.`}</Text>
        ) : null}
        <TextField
          label={`Type ${DELETE_CONFIRM_WORD} to confirm`}
          helper={`Type the word ${DELETE_CONFIRM_WORD}. Capital letters do not matter.`}
          value={typed}
          onChangeText={setTyped}
          editable={!deletion.isPending}
          autoCapitalize="characters"
          autoCorrect={false}
          autoComplete="off"
          autoFocus
          returnKeyType="done"
          onSubmitEditing={submit}
          testID="delete-confirm-input"
        />
        {failure ? (
          <Banner
            tone="error"
            message={
              offline
                ? 'No connection. Nothing was deleted and you are still signed in. Check your internet and try again.'
                : userMessage(failure.code, failure.field)
            }
          />
        ) : null}
        <Button
          label={failure ? 'Try again: delete my account' : 'Delete my account'}
          variant="danger"
          icon="trash"
          fullWidth
          loading={deletion.isPending}
          disabled={!canSubmitDeletion(state, typed, false)}
          onPress={submit}
          testID="delete-confirm-button"
        />
        <Button
          label="Back"
          variant="ghost"
          fullWidth
          disabled={deletion.isPending}
          onPress={() => {
            deletion.reset();
            dispatch({ type: 'back' });
          }}
        />
      </>
    );
  }

  return (
    <ResponsiveModal visible={visible} onClose={close} variant="page" kind="dialog">
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ padding: spacing.lg, gap: spacing.lg }}
        keyboardShouldPersistTaps="handled"
        accessibilityViewIsModal
      >
        {body}
      </ScrollView>
    </ResponsiveModal>
  );
}
