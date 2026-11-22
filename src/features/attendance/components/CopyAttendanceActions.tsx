import * as Clipboard from 'expo-clipboard';
import { useEffect, useState } from 'react';
import { Share, View } from 'react-native';

import { reportError } from '@/lib/logger';
import { Banner, Button, useTheme } from '@/ui';

const COPIED_NOTICE_MS = 3000;

/** Copy / Share the attendance list as text. Display only: it reads what is on screen. */
export function CopyAttendanceActions({ text }: { text: string }) {
  const { spacing } = useTheme();
  const [copied, setCopied] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    if (!copied) return undefined;
    const timer = setTimeout(() => setCopied(false), COPIED_NOTICE_MS);
    return () => clearTimeout(timer);
  }, [copied]);

  const copy = async () => {
    setProblem(null);
    try {
      // Resolves false on web when the browser refuses clipboard access.
      if (await Clipboard.setStringAsync(text)) setCopied(true);
      else setProblem('Could not copy the list. Use Share instead.');
    } catch (error) {
      reportError('attendance.copy', error);
      setProblem('Could not copy the list. Use Share instead.');
    }
  };

  const share = async () => {
    setProblem(null);
    try {
      await Share.share({ message: text });
    } catch (error) {
      reportError('attendance.share', error);
      setProblem('Sharing is not available here. Copy the list instead.');
    }
  };

  return (
    <View style={{ gap: spacing.sm }}>
      <View style={{ flexDirection: 'row', gap: spacing.sm }}>
        <View style={{ flex: 1 }}>
          <Button
            label={copied ? 'Copied' : 'Copy list'}
            variant="secondary"
            icon={copied ? 'check' : 'copy'}
            onPress={() => {
              void copy();
            }}
            fullWidth
          />
        </View>
        <View style={{ flex: 1 }}>
          <Button
            label="Share"
            variant="secondary"
            icon="share"
            onPress={() => {
              void share();
            }}
            fullWidth
          />
        </View>
      </View>
      {problem ? <Banner tone="warning" message={problem} /> : null}
    </View>
  );
}
