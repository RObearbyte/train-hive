import { useRouter, type Href } from 'expo-router';
import { useRef, useState } from 'react';
import { Pressable, ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useCurrentMembership } from '@/features/community/hooks/useCurrentMembership';
import { formatInvitationCode } from '@/features/onboarding/domain/invitationCode';
import { ResponsiveModal } from '@/features/shell/components/ResponsiveModal';
import { useKeyboardVisible } from '@/features/shell/hooks/useKeyboardVisible';
import { useLayout } from '@/features/shell/hooks/useLayout';
import type { Community } from '@/lib/database.types';
import { isValidTimeZone } from '@/lib/datetime';
import { toAppError } from '@/lib/errors';
import { useNow } from '@/lib/useNow';
import { Banner, Button, Card, Icon, IconButton, LoadingState, Text, useTheme } from '@/ui';

import { createInvitationFailure, expiryText } from '../domain/createInvitation';
import { remainingUsesText } from '../domain/invitation';
import {
  FAB_SIZE,
  INITIAL_QUICK_INVITE,
  QUICK_INVITE_CREATED_HINT,
  inviteFabVisible,
  quickInviteReducer,
  quickInviteRequest,
  type QuickInviteEvent,
  type QuickInviteState,
} from '../domain/quickInvite';
import { useCreateInvitation } from '../hooks/useInvitations';
import { InvitationCodeActions } from './InvitationCodeActions';

/**
 * The round "Invite" button (organizers of the active community only) and the
 * "Invite someone" sheet it opens. Render it as a sibling after the screen
 * (inside a `flex: 1` parent): the button floats at the bottom right.
 */
export function QuickInvite() {
  const { community, isOrganizer, activeCommunityId } = useCurrentMembership();
  const keyboardVisible = useKeyboardVisible();
  // Keyed by community: switching communities drops any open sheet and its result.
  if (!community) return null;
  return (
    <QuickInviteFor
      key={community.id}
      community={community}
      visible={inviteFabVisible({
        isOrganizerOfActive: isOrganizer,
        activeCommunityId,
        keyboardVisible,
      })}
    />
  );
}

function QuickInviteFor({ community, visible }: { community: Community; visible: boolean }) {
  const router = useRouter();
  const { colors, elevation, spacing } = useTheme();
  const insets = useSafeAreaInsets();
  const { sidebar } = useLayout();
  const create = useCreateInvitation(community.id);
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<QuickInviteState>(INITIAL_QUICK_INVITE);
  // The machine is stepped synchronously so a double tap can never start two requests.
  const stateRef = useRef<QuickInviteState>(INITIAL_QUICK_INVITE);

  const send = (event: QuickInviteEvent) => {
    const next = quickInviteReducer(stateRef.current, event);
    stateRef.current = next;
    setState(next);
  };

  const start = () => {
    const before = stateRef.current;
    send({ type: 'create' });
    if (stateRef.current === before) return; // one is already being created
    const { attempt } = stateRef.current;
    create.mutateAsync(quickInviteRequest()).then(
      (invitation) => send({ type: 'succeeded', attempt, invitation }),
      (error: unknown) => send({ type: 'failed', attempt, error: toAppError(error) }),
    );
  };

  const show = () => {
    setOpen(true);
    start();
  };
  const close = () => {
    setOpen(false);
    send({ type: 'close' });
  };
  const moreOptions = () => {
    close();
    router.push('/invitations' as Href);
  };

  // Phones: the tab bar already sits below the scene. Wide web has none, so stay clear of the edge.
  const bottom = spacing.lg + (sidebar ? insets.bottom : 0);

  return (
    <>
      {visible && !open ? (
        <Pressable
          onPress={show}
          accessibilityRole="button"
          accessibilityLabel="Invite someone"
          accessibilityHint="Creates an invitation code"
          style={({ pressed, focused }: { pressed: boolean; focused?: boolean }) => [
            elevation.medium,
            {
              position: 'absolute',
              right: spacing.lg + insets.right,
              bottom,
              width: FAB_SIZE,
              height: FAB_SIZE,
              borderRadius: FAB_SIZE / 2,
              backgroundColor: colors.accent,
              alignItems: 'center',
              justifyContent: 'center',
              borderWidth: 2,
              // Visible keyboard focus on the web.
              borderColor: focused ? colors.text : 'transparent',
              opacity: pressed ? 0.85 : 1,
            },
          ]}
        >
          <Icon name="plus" size={22} color="onAccent" />
          <Text
            color="onAccent"
            style={{ fontSize: 11, lineHeight: 13, fontWeight: '700' }}
          >
            Invite
          </Text>
        </Pressable>
      ) : null}

      <ResponsiveModal visible={open} onClose={close} variant="sheet">
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm }}>
          <Text variant="heading" accessibilityRole="header" style={{ flex: 1 }}>
            Invite someone
          </Text>
          <IconButton icon="close" accessibilityLabel="Close" onPress={close} />
        </View>
        <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ gap: spacing.md }}>
          <SheetBody
            state={state}
            community={community}
            onCreate={start}
            onMoreOptions={moreOptions}
          />
        </ScrollView>
      </ResponsiveModal>
    </>
  );
}

function SheetBody({
  state,
  community,
  onCreate,
  onMoreOptions,
}: {
  state: QuickInviteState;
  community: Community;
  onCreate: () => void;
  onMoreOptions: () => void;
}) {
  const { spacing } = useTheme();
  const now = useNow();
  const zone = isValidTimeZone(community.timezone) ? community.timezone : 'UTC';

  const more = (
    <Button label="More options" variant="ghost" size="sm" icon="chevron-right" onPress={onMoreOptions} />
  );

  if (state.phase === 'error') {
    return (
      <>
        <Banner
          tone="error"
          message={createInvitationFailure(state.error).message}
          action={{ label: 'Try again', onPress: onCreate }}
        />
        <View style={{ alignItems: 'flex-start' }}>{more}</View>
      </>
    );
  }

  if (state.phase === 'created') {
    const { invitation } = state;
    return (
      <>
        <Card style={{ gap: spacing.xs, alignItems: 'center' }}>
          <Text variant="caption" color="textMuted">
            Invitation code
          </Text>
          <Text variant="title" selectable style={{ letterSpacing: 4 }}>
            {formatInvitationCode(invitation.code)}
          </Text>
          <Text color="textMuted" align="center">
            {remainingUsesText(invitation)} · {expiryText(invitation, zone, now)}
          </Text>
        </Card>
        <InvitationCodeActions
          invitation={invitation}
          communityName={community.name}
          zone={zone}
          now={now}
          showPreview
        />
        <Text variant="caption" color="textMuted">
          {QUICK_INVITE_CREATED_HINT}
        </Text>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm }}>
          <Button label="Create another" variant="secondary" size="sm" icon="plus" onPress={onCreate} />
          {more}
        </View>
      </>
    );
  }

  // idle (a moment before the first request) and creating
  return <LoadingState message="Creating an invitation code" style={{ paddingVertical: spacing.xl }} />;
}
