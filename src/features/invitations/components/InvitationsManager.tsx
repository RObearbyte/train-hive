import { useState } from 'react';
import { View } from 'react-native';

import { ConfirmDialog } from '@/features/community/components/ConfirmDialog';
import { formatInvitationCode } from '@/features/onboarding/domain/invitationCode';
import type { Community, InvitationCode } from '@/lib/database.types';
import { isValidTimeZone } from '@/lib/datetime';
import { userMessage } from '@/lib/errors';
import { reportError } from '@/lib/logger';
import { useNow } from '@/lib/useNow';
import {
  Banner,
  Button,
  Card,
  EmptyState,
  ErrorState,
  Icon,
  LoadingState,
  Text,
  useTheme,
  type ColorToken,
  type IconName,
} from '@/ui';

import {
  expiryText,
  invitationStateLabel,
} from '../domain/createInvitation';
import { invitationState, remainingUsesText, type InvitationState } from '../domain/invitation';
import { useInvitations, useRevokeInvitation } from '../hooks/useInvitations';
import { CreateInvitationForm } from './CreateInvitationForm';
import { InvitationCodeActions } from './InvitationCodeActions';

// State is glyph + label, never color alone.
const STATE_STYLE: Record<InvitationState, { icon: IconName; color: ColorToken }> = {
  active: { icon: 'check-circle', color: 'success' },
  expired: { icon: 'clock', color: 'warning' },
  revoked: { icon: 'ban', color: 'danger' },
  exhausted: { icon: 'info', color: 'textMuted' },
};

function InvitationRow({
  invitation,
  communityName,
  zone,
  now,
  onRevoke,
}: {
  invitation: InvitationCode;
  communityName: string;
  zone: string;
  now: Date;
  onRevoke: () => void;
}) {
  const { spacing } = useTheme();
  const state = invitationState(invitation, now);
  const style = STATE_STYLE[state];
  const count = invitation.redemption_count;
  const used = count === 0 ? 'Not used yet' : count === 1 ? 'Used once' : `Used ${count} times`;

  return (
    <Card style={{ gap: spacing.sm }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm }}>
        <Text variant="heading" selectable style={{ flex: 1, letterSpacing: 2 }}>
          {formatInvitationCode(invitation.code)}
        </Text>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.xs }}>
          <Icon name={style.icon} size={18} color={style.color} />
          <Text variant="label" color={style.color}>
            {invitationStateLabel(state)}
          </Text>
        </View>
      </View>
      <View style={{ gap: spacing.xxs }}>
        <Text color="textMuted">
          {remainingUsesText(invitation)} · {used}
        </Text>
        <Text color="textMuted">{expiryText(invitation, zone, now)}</Text>
        {invitation.role === 'organizer' ? (
          <Text color="textMuted">Grants the organizer role</Text>
        ) : null}
      </View>
      {state === 'active' ? (
        <InvitationCodeActions
          code={invitation.code}
          communityName={communityName}
          onRevoke={onRevoke}
        />
      ) : null}
    </Card>
  );
}

/** Organizer's invitation management: create a code, see the new one large, list and revoke. */
export function InvitationsManager({ community }: { community: Community }) {
  const { spacing } = useTheme();
  const now = useNow();
  const invitations = useInvitations(community.id);
  const revoke = useRevokeInvitation(community.id);
  const [created, setCreated] = useState<InvitationCode | null>(null);
  const [revoking, setRevoking] = useState<InvitationCode | null>(null);

  const zone = isValidTimeZone(community.timezone) ? community.timezone : 'UTC';
  const refetch = () => {
    invitations.refetch().catch((error: unknown) => reportError('invitations.refetch', error));
  };

  const closeRevoke = () => {
    setRevoking(null);
    revoke.reset();
  };
  const confirmRevoke = () => {
    if (!revoking || revoke.isPending) return;
    const id = revoking.id;
    revoke.mutate(id, {
      onSuccess: () => {
        setRevoking(null);
        // The big "new code" card must not keep offering a revoked code.
        setCreated((current) => (current?.id === id ? null : current));
      },
    });
  };

  // The list is the server's truth for the new code too (it may be revoked or used meanwhile).
  const list = invitations.data ?? [];
  const createdNow = created ? (list.find((row) => row.id === created.id) ?? created) : null;
  const createdActive = createdNow !== null && invitationState(createdNow, now) === 'active';

  let listBody;
  if (invitations.data && list.length > 0) {
    listBody = list.map((invitation) => (
      <InvitationRow
        key={invitation.id}
        invitation={invitation}
        communityName={community.name}
        zone={zone}
        now={now}
        onRevoke={() => {
          revoke.reset();
          setRevoking(invitation);
        }}
      />
    ));
  } else if (invitations.data) {
    listBody = (
      <EmptyState
        title="No invitation codes yet"
        message={`Create a code and share it to invite people to ${community.name}.`}
      />
    );
  } else if (invitations.isError) {
    listBody = (
      <ErrorState
        title="Could not load the codes"
        message={userMessage(invitations.error.code, invitations.error.field)}
        onRetry={refetch}
      />
    );
  } else {
    listBody = <LoadingState message="Loading invitation codes" />;
  }

  return (
    <View style={{ gap: spacing.lg }}>
      {createdNow && createdActive ? (
        <Card style={{ gap: spacing.md }}>
          <Banner tone="success" message="Code created. Share it with the people you want to invite." />
          <Text
            variant="display"
            align="center"
            selectable
            accessibilityLabel={`Invitation code ${formatInvitationCode(createdNow.code).split('').join(' ')}`}
            style={{ letterSpacing: 4 }}
          >
            {formatInvitationCode(createdNow.code)}
          </Text>
          <Text color="textMuted" align="center">
            {remainingUsesText(createdNow)} · {expiryText(createdNow, zone, now)}
          </Text>
          <InvitationCodeActions code={createdNow.code} communityName={community.name} />
          <View style={{ alignItems: 'flex-start' }}>
            <Button label="Done" variant="ghost" size="sm" onPress={() => setCreated(null)} />
          </View>
        </Card>
      ) : null}

      <Card>
        <CreateInvitationForm communityId={community.id} onCreated={setCreated} />
      </Card>

      <Text variant="heading">Codes</Text>
      {/* Showing what is cached while the latest refresh failed. */}
      {invitations.isError && invitations.data ? (
        <Banner
          tone="warning"
          message={userMessage(invitations.error.code, invitations.error.field)}
          action={{ label: 'Try again', onPress: refetch }}
        />
      ) : null}
      {listBody}

      <ConfirmDialog
        visible={revoking !== null}
        title="Revoke this code?"
        message={
          revoking
            ? `Nobody will be able to join with ${formatInvitationCode(revoking.code)} any more. People who already joined stay members. This cannot be undone.`
            : ''
        }
        confirmLabel="Revoke code"
        cancelLabel="Keep code"
        destructive
        pending={revoke.isPending}
        error={revoke.error ? userMessage(revoke.error.code, revoke.error.field) : null}
        onConfirm={confirmRevoke}
        onCancel={closeRevoke}
      />
    </View>
  );
}
