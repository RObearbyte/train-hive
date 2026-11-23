import { Redirect, useRouter, type Href } from 'expo-router';
import { useState } from 'react';
import { View } from 'react-native';

import { EmergencyListSection } from '@/features/aboutYou/components/EmergencyListSection';
import { MemberEmergencySection } from '@/features/aboutYou/components/MemberEmergencySection';
import { RoleBadge } from '@/features/communities/components/YourCommunities';
import { ConfirmDialog } from '@/features/community/components/ConfirmDialog';
import { useSession } from '@/features/community/hooks/SessionProvider';
import { useCurrentMembership } from '@/features/community/hooks/useCurrentMembership';
import { FEATURES } from '@/features/legal/constants';
import { ResponsiveModal } from '@/features/shell/components/ResponsiveModal';
import { formatLongDate, isValidTimeZone } from '@/lib/datetime';
import { userMessage } from '@/lib/errors';
import { reportError } from '@/lib/logger';
import { Avatar, Banner, Button, Card, Divider, EmptyState, ErrorState, ListItem, LoadingState, Screen, Text, useTheme } from '@/ui';

import {
  ACTION_LABELS,
  actionConfirmation,
  availableActions,
  memberActionErrorMessage,
  rosterName,
  splitRoster,
  type MemberAction,
  type RosterEntry,
} from '../domain/memberActions';
import { useRemoveMember, useRoster, useSetMemberRole } from '../hooks/useMembers';

function goBack(router: ReturnType<typeof useRouter>) {
  if (router.canGoBack()) router.back();
  else router.replace('/profile' as Href);
}

/** Profile -> Members: organizers see everyone in the community and can change roles or remove people. The server checks every action again. */
export function MembersScreen() {
  const router = useRouter();
  const current = useCurrentMembership();
  const { community, isOrganizer } = current;

  // Organizers only; members never see the entry and the server refuses them anyway.
  if (community && !isOrganizer) return <Redirect href={'/profile' as Href} />;

  const header = (
    <>
      <View style={{ alignItems: 'flex-start' }}>
        <Button label="Back" variant="ghost" size="sm" icon="chevron-left" onPress={() => goBack(router)} />
      </View>
      <Text variant="title">Members</Text>
    </>
  );

  if (!community) {
    return (
      <Screen>
        {header}
        {current.error ? (
          <ErrorState
            message={userMessage(current.error.code, current.error.field)}
            onRetry={() => {
              current.refetch().catch((error: unknown) => reportError('members.retryCommunity', error));
            }}
            style={{ flex: 1 }}
          />
        ) : (
          <LoadingState message="Loading your community" style={{ flex: 1 }} />
        )}
      </Screen>
    );
  }

  // Keyed by community so a switch never shows one community's people under another's name.
  return <MembersBody key={community.id} header={header} communityId={community.id} communityName={community.name} zone={community.timezone} />;
}

function MembersBody({
  header,
  communityId,
  communityName,
  zone,
}: {
  header: React.ReactNode;
  communityId: string;
  communityName: string;
  zone: string;
}) {
  const { spacing } = useTheme();
  const { userId } = useSession();
  const roster = useRoster(communityId);
  const setRole = useSetMemberRole(communityId);
  const remove = useRemoveMember(communityId);
  const [target, setTarget] = useState<RosterEntry | null>(null);
  const [pending, setPending] = useState<{ action: MemberAction; entry: RosterEntry } | null>(null);
  const [showFormer, setShowFormer] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const safeZone = isValidTimeZone(zone) ? zone : 'UTC';
  const split = roster.data ? splitRoster(roster.data) : null;
  const busy = setRole.isPending || remove.isPending;
  const mutation = pending?.action === 'remove' ? remove : setRole;

  const refresh = () => {
    roster.refetch().catch((error: unknown) => reportError('members.refresh', error));
  };

  const confirm = () => {
    if (!pending || busy) return;
    const { action, entry } = pending;
    const name = rosterName(entry);
    const done = (message: string) => () => {
      setPending(null);
      setNotice(message);
    };
    if (action === 'remove') {
      remove.mutate({ userId: entry.userId }, { onSuccess: done(`${name} was removed from ${communityName}.`) });
    } else {
      const role = action === 'make_organizer' ? 'organizer' : 'member';
      setRole.mutate(
        { userId: entry.userId, role },
        { onSuccess: done(`${name} is now ${role === 'organizer' ? 'an organizer' : 'a member'}.`) },
      );
    }
  };

  const dismissPending = () => {
    setPending(null);
    setRole.reset();
    remove.reset();
  };

  let body;
  if (roster.isPending) {
    body = <LoadingState message="Loading members" style={{ flex: 1 }} />;
  } else if (roster.isError && !roster.data) {
    body = (
      <ErrorState
        title="Could not load members"
        message={userMessage(roster.error.code, roster.error.field)}
        onRetry={refresh}
        style={{ flex: 1 }}
      />
    );
  } else if (split) {
    body = (
      <>
        {roster.isError ? (
          <Banner
            tone="warning"
            message={userMessage(roster.error.code, roster.error.field)}
            action={{ label: 'Try again', onPress: refresh }}
          />
        ) : null}
        {split.active.length === 0 ? (
          <EmptyState title="No members yet" message="Invite people with a code from Profile, Invitations." />
        ) : (
          <Card style={{ padding: 0 }}>
            {split.active.map((entry, index) => {
              const name = rosterName(entry);
              const isSelf = entry.userId === userId;
              const actions = availableActions(entry, userId);
              const role = entry.role === 'organizer' ? 'Organizer' : 'Member';
              return (
                <View key={entry.membershipId}>
                  {index > 0 ? <Divider /> : null}
                  <ListItem
                    title={isSelf ? `${name} (you)` : name}
                    subtitle={`Joined ${formatLongDate(entry.joinedAt, safeZone)}`}
                    leading={<Avatar name={name} size={36} />}
                    trailing={<RoleBadge role={role} />}
                    showChevron
                    accessibilityLabel={`${name}${isSelf ? ', you' : ''}, ${role}, joined ${formatLongDate(entry.joinedAt, safeZone)}. Open details${actions.length > 0 ? ' and actions' : ''}`}
                    onPress={() => setTarget(entry)}
                    testID={`member-row-${entry.userId}`}
                  />
                </View>
              );
            })}
          </Card>
        )}

        {split.former.length > 0 ? (
          <View style={{ gap: spacing.sm }}>
            <Button
              label={`${showFormer ? 'Hide' : 'Show'} former members (${split.former.length})`}
              variant="ghost"
              size="sm"
              icon={showFormer ? 'chevron-left' : 'chevron-right'}
              onPress={() => setShowFormer((open) => !open)}
              accessibilityHint="People who left or were removed"
            />
            {showFormer ? (
              <Card style={{ padding: 0 }}>
                {split.former.map((entry, index) => (
                  <View key={entry.membershipId}>
                    {index > 0 ? <Divider /> : null}
                    <ListItem
                      title={rosterName(entry)}
                      subtitle={`${entry.role === 'organizer' ? 'Was an organizer' : 'Was a member'}, joined ${formatLongDate(entry.joinedAt, safeZone)}`}
                    />
                  </View>
                ))}
              </Card>
            ) : null}
            {showFormer ? (
              <Text variant="caption" color="textMuted">
                Their names are not shown. Their attendance history stays in the community&apos;s records.
              </Text>
            ) : null}
          </View>
        ) : null}
      </>
    );
  }

  const targetName = target ? rosterName(target) : '';
  const targetActions = target ? availableActions(target, userId) : [];
  const confirmation = pending ? actionConfirmation(pending.action, rosterName(pending.entry), communityName) : null;

  return (
    <Screen scroll onRefresh={refresh} refreshing={roster.isRefetching}>
      {header}
      <Text color="textMuted">{`Everyone in ${communityName}. Tap a person to see what they shared with organizers, change their role or remove them.`}</Text>
      {notice ? <Banner tone="success" message={notice} /> : null}
      {body}

      {FEATURES.emergencyContact && split && split.active.length > 0 ? (
        <EmergencyListSection communityId={communityId} communityName={communityName} />
      ) : null}

      <ResponsiveModal visible={target !== null} onClose={() => setTarget(null)} variant="sheet">
        {target ? (
          <View style={{ gap: spacing.md }} accessibilityViewIsModal>
            <Text variant="heading">{targetName}</Text>
            <Text color="textMuted">{target.role === 'organizer' ? 'Organizer' : 'Member'}</Text>
            {FEATURES.emergencyContact ? (
              <MemberEmergencySection communityId={communityId} userId={target.userId} />
            ) : null}
            {targetActions.map((action) => (
              <Button
                key={action}
                label={ACTION_LABELS[action]}
                variant={action === 'remove' ? 'danger' : 'secondary'}
                icon={action === 'remove' ? 'trash' : undefined}
                fullWidth
                onPress={() => {
                  setNotice(null);
                  setPending({ action, entry: target });
                  setTarget(null);
                }}
              />
            ))}
            <Button label="Cancel" variant="ghost" fullWidth onPress={() => setTarget(null)} />
          </View>
        ) : null}
      </ResponsiveModal>

      <ConfirmDialog
        visible={pending !== null && confirmation !== null}
        title={confirmation?.title ?? ''}
        message={confirmation?.message ?? ''}
        confirmLabel={confirmation?.confirmLabel ?? ''}
        cancelLabel={confirmation?.cancelLabel ?? ''}
        destructive={confirmation?.destructive ?? false}
        pending={busy}
        error={mutation.isError ? memberActionErrorMessage(mutation.error) : null}
        onConfirm={confirm}
        onCancel={dismissPending}
      />
    </Screen>
  );
}
