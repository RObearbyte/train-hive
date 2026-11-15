import * as Clipboard from 'expo-clipboard';
import { useEffect, useState } from 'react';
import { Share, View } from 'react-native';

import { formatInvitationCode } from '@/features/onboarding/domain/invitationCode';
import { reportError } from '@/lib/logger';
import { Banner, Button, useTheme } from '@/ui';

import { invitationShareMessage } from '../domain/createInvitation';

const COPIED_NOTICE_MS = 2500;

function isShareCancelled(error: unknown): boolean {
  // On web, closing the browser's share sheet rejects with AbortError: not a failure.
  return typeof error === 'object' && error !== null && (error as { name?: unknown }).name === 'AbortError';
}

export interface InvitationCodeActionsProps {
  code: string;
  communityName: string;
  /** Adds a Revoke button. */
  onRevoke?: () => void;
}

/** Copy / Share (and optionally Revoke) for one code, with the outcome shown underneath. */
export function InvitationCodeActions({ code, communityName, onRevoke }: InvitationCodeActionsProps) {
  const { spacing } = useTheme();
  const [copied, setCopied] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const formatted = formatInvitationCode(code);

  useEffect(() => {
    if (!copied) return undefined;
    const timer = setTimeout(() => setCopied(false), COPIED_NOTICE_MS);
    return () => clearTimeout(timer);
  }, [copied]);

  const copy = async () => {
    setProblem(null);
    try {
      // Resolves false on web when the browser refuses clipboard access.
      const saved = await Clipboard.setStringAsync(formatted);
      if (saved) setCopied(true);
      else setProblem('Could not copy the code. Select it and copy it by hand.');
    } catch (error) {
      reportError('invitations.copy', error);
      setProblem('Could not copy the code. Select it and copy it by hand.');
    }
  };

  const share = async () => {
    setProblem(null);
    try {
      await Share.share({ message: invitationShareMessage(communityName, formatted) });
    } catch (error) {
      if (isShareCancelled(error)) return;
      reportError('invitations.share', error);
      setProblem('Sharing is not available here. Copy the code instead.');
    }
  };

  return (
    <View style={{ gap: spacing.sm }}>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm }}>
        <Button
          label={copied ? 'Copied' : 'Copy'}
          accessibilityLabel={copied ? `Copied code ${formatted}` : `Copy code ${formatted}`}
          variant="secondary"
          size="sm"
          icon={copied ? 'check' : 'copy'}
          onPress={() => void copy()}
        />
        <Button
          label="Share"
          accessibilityLabel={`Share code ${formatted}`}
          variant="secondary"
          size="sm"
          icon="share"
          onPress={() => void share()}
        />
        {onRevoke ? (
          <Button
            label="Revoke"
            accessibilityLabel={`Revoke code ${formatted}`}
            variant="ghost"
            size="sm"
            icon="ban"
            onPress={onRevoke}
          />
        ) : null}
      </View>
      {problem ? <Banner tone="error" message={problem} /> : null}
    </View>
  );
}
