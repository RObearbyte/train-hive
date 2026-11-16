import * as Clipboard from 'expo-clipboard';
import { useEffect, useMemo, useState } from 'react';
import { AccessibilityInfo, Platform, Share, View } from 'react-native';

import { formatInvitationCode } from '@/features/onboarding/domain/invitationCode';
import { APP_DOWNLOAD_URL, WEB_APP_URL } from '@/lib/appLink';
import type { InvitationCode } from '@/lib/database.types';
import { reportError } from '@/lib/logger';
import { Banner, Button, Text, useTheme } from '@/ui';

import { remainingUses } from '../domain/invitation';
import { buildInvitationMessage } from '../domain/invitationMessage';

const COPIED_NOTICE_MS = 2500;

/** Native always has a share sheet; a browser only when it implements the Web Share API (many desktop browsers do not). */
function canShare(): boolean {
  if (Platform.OS !== 'web') return true;
  return typeof navigator !== 'undefined' && typeof navigator.share === 'function';
}

function isShareCancelled(error: unknown): boolean {
  // On web, closing the browser's share sheet rejects with AbortError: not a failure.
  return typeof error === 'object' && error !== null && (error as { name?: unknown }).name === 'AbortError';
}

export interface InvitationCodeActionsProps {
  invitation: Pick<InvitationCode, 'code' | 'expires_at' | 'max_redemptions' | 'redemption_count'>;
  /** From the current community; the message falls back to a neutral wording without it. */
  communityName: string | null | undefined;
  /** The community's IANA time zone, for the expiry date in the message. */
  zone: string;
  now: Date;
  /** Shows the message text in a card above the buttons. */
  showPreview?: boolean;
  /** Adds a Revoke button. */
  onRevoke?: () => void;
}

type Copied = 'message' | 'code';

/** Copy message / Share / Copy code only (and optionally Revoke) for one active code. */
export function InvitationCodeActions({
  invitation,
  communityName,
  zone,
  now,
  showPreview = false,
  onRevoke,
}: InvitationCodeActionsProps) {
  const { spacing, colors, radii } = useTheme();
  const [copied, setCopied] = useState<Copied | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const formatted = formatInvitationCode(invitation.code);

  const message = useMemo(
    () =>
      buildInvitationMessage({
        communityName,
        code: invitation.code,
        expiresAt: invitation.expires_at,
        maxRedemptions: invitation.max_redemptions,
        remainingUses: remainingUses(invitation),
        appLink: APP_DOWNLOAD_URL,
        webAppUrl: WEB_APP_URL,
        now,
        timeZone: zone,
      }),
    [communityName, invitation, now, zone],
  );

  useEffect(() => {
    if (!copied) return undefined;
    const timer = setTimeout(() => setCopied(null), COPIED_NOTICE_MS);
    return () => clearTimeout(timer);
  }, [copied]);

  const copy = async (what: Copied) => {
    setProblem(null);
    const text = what === 'message' ? message : formatted;
    const failure =
      what === 'message'
        ? 'Could not copy the message. Select it and copy it by hand.'
        : 'Could not copy the code. Select it and copy it by hand.';
    try {
      // Resolves false on web when the browser refuses clipboard access.
      const saved = await Clipboard.setStringAsync(text);
      if (saved) {
        setCopied(what);
        // Announce once: iOS has no live regions, so it is told here; elsewhere the visible
        // live region below is read by TalkBack (announcing as well made it read twice).
        if (Platform.OS === 'ios') {
          AccessibilityInfo.announceForAccessibility(what === 'message' ? 'Message copied' : 'Code copied');
        }
      } else {
        setProblem(failure);
      }
    } catch (error) {
      reportError('invitations.copy', error);
      setProblem(failure);
    }
  };

  const share = async () => {
    setProblem(null);
    try {
      await Share.share({ message });
    } catch (error) {
      if (isShareCancelled(error)) return;
      reportError('invitations.share', error);
      setProblem('Sharing is not available here. Copy the message instead.');
    }
  };

  return (
    <View style={{ gap: spacing.sm }}>
      {showPreview ? (
        <View
          style={{
            backgroundColor: colors.surface,
            borderColor: colors.border,
            borderWidth: 1,
            borderRadius: radii.md,
            padding: spacing.md,
            gap: spacing.xs,
          }}
        >
          <Text variant="label" color="textMuted">
            Message to send
          </Text>
          <Text selectable>{message}</Text>
        </View>
      ) : null}
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm }}>
        <Button
          label={copied === 'message' ? 'Copied' : 'Copy message'}
          accessibilityLabel={
            copied === 'message' ? `Message copied for code ${formatted}` : `Copy invitation message for code ${formatted}`
          }
          size="sm"
          icon={copied === 'message' ? 'check' : 'copy'}
          onPress={() => void copy('message')}
        />
        {canShare() ? (
          <Button
            label="Share"
            accessibilityLabel={`Share invitation message for code ${formatted}`}
            variant="secondary"
            size="sm"
            icon="share"
            onPress={() => void share()}
          />
        ) : null}
        <Button
          label={copied === 'code' ? 'Copied' : 'Copy code only'}
          accessibilityLabel={copied === 'code' ? `Code ${formatted} copied` : `Copy code ${formatted} only`}
          variant="ghost"
          size="sm"
          icon={copied === 'code' ? 'check' : undefined}
          onPress={() => void copy('code')}
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
      {copied ? (
        <Text color="success" accessibilityLiveRegion={Platform.OS === 'ios' ? 'none' : 'polite'}>
          {copied === 'message' ? 'Message copied' : 'Code copied'}
        </Text>
      ) : null}
      {problem ? <Banner tone="error" message={problem} /> : null}
    </View>
  );
}
