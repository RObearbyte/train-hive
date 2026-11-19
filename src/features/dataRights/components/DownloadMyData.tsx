import { Platform, View } from 'react-native';

import { Banner, Button, Text, useTheme } from '@/ui';

import { exportErrorMessage, exportSuccessMessage, exportTruncatedWarning } from '../domain/exportFile';
import { useDownloadMyData } from '../hooks/useDownloadMyData';

/**
 * "Download my data": asks the server for the export and saves or shares it as
 * a JSON file. Shows progress, a summary of what the file holds, and clear
 * errors (including the hourly limit).
 */
export function DownloadMyData() {
  const { spacing } = useTheme();
  const download = useDownloadMyData();
  const summary = download.data?.summary;
  const truncated = summary ? exportTruncatedWarning(summary) : null;

  return (
    <View style={{ gap: spacing.sm }}>
      <Button
        label={download.isPending ? 'Preparing your data' : 'Download my data'}
        variant="secondary"
        icon="share"
        fullWidth
        loading={download.isPending}
        accessibilityHint={
          Platform.OS === 'web'
            ? 'Saves a file with everything TrainHive holds about you'
            : 'Opens the share sheet with a file of everything TrainHive holds about you'
        }
        onPress={() => {
          if (!download.isPending) download.mutate();
        }}
      />
      {download.isError ? (
        <Banner
          tone="error"
          message={exportErrorMessage(download.error)}
          action={
            download.error.code === 'rate_limited'
              ? undefined
              : { label: 'Try again', onPress: () => download.mutate() }
          }
        />
      ) : null}
      {summary ? (
        <>
          <Banner tone="success" message={exportSuccessMessage(summary)} />
          {truncated ? <Banner tone="warning" message={truncated} /> : null}
          {download.data?.method === 'text' ? (
            <Text variant="caption" color="textMuted">
              Your device could not save a file, so the data was shared as text instead.
            </Text>
          ) : null}
        </>
      ) : null}
    </View>
  );
}
