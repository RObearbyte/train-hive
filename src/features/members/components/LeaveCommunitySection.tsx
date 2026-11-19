import { useRouter, type Href } from 'expo-router';
import { useState } from 'react';

import { ConfirmDialog } from '@/features/community/components/ConfirmDialog';
import { Icon, ListItem } from '@/ui';

import { LEAVE_MESSAGE, LEAVE_TITLE, leaveErrorMessage, leaveNeedsHandover } from '../domain/memberActions';
import { useLeaveCommunity } from '../hooks/useMembers';

/**
 * Profile -> "Leave this community", for any member. The last organizer of a
 * community that still has other members is told to hand over on the Members
 * screen first (the server refuses it with `last_organizer`). After leaving,
 * the app shows another of my communities, or onboarding when none is left.
 */
export function LeaveCommunitySection({ communityId, communityName }: { communityId: string; communityName: string }) {
  const router = useRouter();
  const leave = useLeaveCommunity();
  const [open, setOpen] = useState(false);

  const close = () => {
    setOpen(false);
    leave.reset();
  };
  const handover = leave.isError && leaveNeedsHandover(leave.error);

  return (
    <>
      <ListItem
        title="Leave this community"
        subtitle={`You will lose access to ${communityName}`}
        leading={<Icon name="close" size={22} color="danger" />}
        accessibilityLabel={`Leave ${communityName}. Asks for confirmation first`}
        onPress={() => {
          leave.reset();
          setOpen(true);
        }}
        testID="leave-community"
      />
      <ConfirmDialog
        visible={open}
        title={LEAVE_TITLE(communityName)}
        message={LEAVE_MESSAGE}
        confirmLabel={handover ? 'Open members' : 'Leave community'}
        cancelLabel="Stay"
        destructive={!handover}
        pending={leave.isPending}
        error={leave.isError ? leaveErrorMessage(leave.error) : null}
        onConfirm={() => {
          if (handover) {
            close();
            router.push('/members' as Href);
            return;
          }
          leave.mutate({ communityId }, { onSuccess: () => setOpen(false) });
        }}
        onCancel={close}
      />
    </>
  );
}
