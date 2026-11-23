import { useState } from 'react';
import { View } from 'react-native';

import { MemberEmergencySection } from '@/features/aboutYou/components/MemberEmergencySection';
import { RoleBadge } from '@/features/communities/components/YourCommunities';
import { ConfirmDialog } from '@/features/community/components/ConfirmDialog';
import { useSession } from '@/features/community/hooks/SessionProvider';
import { FEATURES } from '@/features/legal/constants';
import { ResponsiveModal } from '@/features/shell/components/ResponsiveModal';
import { formatLongDate, isValidTimeZone } from '@/lib/datetime';
import { userMessage } from '@/lib/errors';
import { reportError } from '@/lib/logger';
import { Avatar, Banner, Button, Card, Divider, EmptyState, ErrorState, ListItem, LoadingState, Text, useTheme } from '@/ui';

import {
  ACTION_LABELS,
  actionConfirmation,
  memberActionErrorMessage,
  rosterName,
  rowActions,
  splitRoster,
  type MemberAction,
  type RosterEntry,
} from '../domain/memberActions';
import { useRemoveMember, useRoster, useSetMemberRole } from '../hooks/useMembers';

/**
 * The people of one community: active members by name with an Organizer badge,
 * the member sheet on tap, and (organizers only) role changes, removal and the
 * former members. Members see name and role only; emergency and T-shirt data
 * and every action are organizer-only here and checked again by the server.
 * Used by the Community tab (everyone) and the organizer's Members screen.
 * Render it inside a scrolling `Screen`; it renders no header of its own.
 */
export function MemberDirectory({
  communityId,
  communityName,
  zone,
  isOrganizer,
  showFormer = false,
  emptyMessage,
}: {
  communityId: string;
  communityName: string;
  zone: string;
  isOrganizer: boolean;
  showFormer?: boolean;
  emptyMessage?: string;
}) {
  const { spacing } = useTheme();
  const { userId } = useSession();
  const roster = useRoster(communityId);
  const setRole = useSetMemberRole(communityId);
  const remove = useRemoveMember(communityId);
  const [target, setTarget] = useState<RosterEntry | null>(null);
  const [pending, setPending] = useState<{ action: MemberAction; entry: RosterEntry } | null>(null);
  const [formerOpen, setFormerOpen] = useState(false);
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
    body = <LoadingState message="Loading members" />;
  } else if (roster.isError && !roster.data) {
    body = (
      <ErrorState
        title="Could not load members"
        message={userMessage(roster.error.code, roster.error.field)}
        onRetry={refresh}
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
          <EmptyState title="No members yet" message={emptyMessage ?? 'Members appear here once they join.'} />
        ) : (
          <Card style={{ padding: 0 }}>
            {split.active.map((entry, index) => {
              const name = rosterName(entry);
              const isSelf = entry.userId === userId;
              const actions = rowActions(entry, userId, isOrganizer);
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

        {showFormer && isOrganizer && split.former.length > 0 ? (
          <View style={{ gap: spacing.sm }}>
            <Button
              label={`${formerOpen ? 'Hide' : 'Show'} former members (${split.former.length})`}
              variant="ghost"
              size="sm"
              icon={formerOpen ? 'chevron-left' : 'chevron-right'}
              onPress={() => setFormerOpen((open) => !open)}
              accessibilityHint="People who left or were removed"
            />
            {formerOpen ? (
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
            {formerOpen ? (
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
  const targetActions = target ? rowActions(target, userId, isOrganizer) : [];
  const confirmation = pending ? actionConfirmation(pending.action, rosterName(pending.entry), communityName) : null;

  return (
    <>
      {notice ? <Banner tone="success" message={notice} /> : null}
      {body}

      <ResponsiveModal visible={target !== null} onClose={() => setTarget(null)} variant="sheet">
        {target ? (
          <View style={{ gap: spacing.md }} accessibilityViewIsModal>
            <Text variant="heading">{targetName}</Text>
            <Text color="textMuted">{target.role === 'organizer' ? 'Organizer' : 'Member'}</Text>
            {isOrganizer && FEATURES.emergencyContact ? (
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
            <Button label={isOrganizer ? 'Cancel' : 'Close'} variant="ghost" fullWidth onPress={() => setTarget(null)} />
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
    </>
  );
}
