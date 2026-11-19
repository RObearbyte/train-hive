import { Linking } from 'react-native';

import { reportError } from '@/lib/logger';
import { Button, Text } from '@/ui';

import { legalConfig } from '../config';

/** The privacy e-mail: a mail button when configured, the `[TO BE FILLED]` marker as plain text when not. */
export function PrivacyContact() {
  if (!legalConfig.emailSet) {
    return (
      <Text color="textMuted" selectable>
        {`Privacy contact: ${legalConfig.privacyEmail}`}
      </Text>
    );
  }
  return (
    <Button
      label={`Email ${legalConfig.privacyEmail}`}
      variant="secondary"
      size="sm"
      icon="share"
      accessibilityLabel={`Email the privacy contact at ${legalConfig.privacyEmail}`}
      onPress={() => {
        Linking.openURL(`mailto:${legalConfig.privacyEmail}`).catch((error: unknown) =>
          reportError('privacy.mailto', error),
        );
      }}
    />
  );
}
