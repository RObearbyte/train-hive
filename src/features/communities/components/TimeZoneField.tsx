import { useMemo, useState } from 'react';
import { FlatList, Modal, View } from 'react-native';

import { useNow } from '@/lib/useNow';
import { Button, Card, EmptyState, Icon, ListItem, Screen, Text, TextField, useTheme } from '@/ui';

import { isCommunityTimeZone } from '../domain/communityForm';
import { listTimeZones, localTimeSummary, searchTimeZones, zoneLabel } from '../domain/timezones';

export type TimeZoneFieldProps = {
  value: string;
  onChange: (zone: string) => void;
  error?: string;
  disabled?: boolean;
  /** Extra line under the field, for example the note about changing the zone later. */
  note?: string;
};

/**
 * Time zone chooser: a field showing the current choice and the local time
 * there (a sanity check), opening a searchable list of IANA zones.
 */
export function TimeZoneField({ value, onChange, error, disabled = false, note }: TimeZoneFieldProps) {
  const { spacing, colors } = useTheme();
  const now = useNow(30_000);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const zones = useMemo(() => {
    const list = listTimeZones();
    // A stored zone the runtime list lacks (older name) stays selectable and visible.
    return isCommunityTimeZone(value) && !list.includes(value) ? [value, ...list] : list;
  }, [value]);
  const results = useMemo(() => searchTimeZones(zones, query), [zones, query]);

  const valid = isCommunityTimeZone(value);
  const close = () => {
    setOpen(false);
    setQuery('');
  };

  return (
    <View style={{ gap: spacing.xs }}>
      <Text variant="label">Time zone</Text>
      <Card
        onPress={disabled ? undefined : () => setOpen(true)}
        accessibilityLabel={`Time zone: ${valid ? zoneLabel(value) : 'not chosen'}. ${
          valid ? `It is ${localTimeSummary(value, now)} there now. ` : ''
        }Change`}
        style={{ borderColor: error ? colors.danger : colors.borderStrong, opacity: disabled ? 0.6 : 1 }}
      >
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.md }}>
          <View style={{ flex: 1, gap: spacing.xxs }}>
            <Text variant="body">{valid ? zoneLabel(value) : 'Choose a time zone'}</Text>
            {valid ? (
              <Text variant="caption" color="textMuted">
                {`Right now it is ${localTimeSummary(value, now)} there`}
              </Text>
            ) : null}
          </View>
          <Icon name="chevron-right" size={20} color="textMuted" />
        </View>
      </Card>
      {error ? (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.xs }} accessibilityLiveRegion="polite">
          <Icon name="alert" size={16} color="danger" />
          <Text variant="caption" color="danger" style={{ flex: 1 }}>
            {error}
          </Text>
        </View>
      ) : null}
      {note ? (
        <Text variant="caption" color="textMuted">
          {note}
        </Text>
      ) : null}

      <Modal visible={open} animationType="slide" onRequestClose={close}>
        <Screen>
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
            <Text variant="title">Time zone</Text>
            <Button label="Close" variant="ghost" size="sm" onPress={close} />
          </View>
          <TextField
            label="Search"
            placeholder="City or region, for example Bucharest"
            value={query}
            onChangeText={setQuery}
            autoCapitalize="none"
            autoCorrect={false}
            autoComplete="off"
            spellCheck={false}
            returnKeyType="search"
            testID="timezone-search"
          />
          <FlatList
            data={results}
            keyExtractor={(zone) => zone}
            keyboardShouldPersistTaps="handled"
            initialNumToRender={20}
            style={{ flex: 1 }}
            ListEmptyComponent={
              <EmptyState title="No matching time zone" message="Try the name of a larger city nearby." />
            }
            renderItem={({ item }) => (
              <ListItem
                title={zoneLabel(item)}
                subtitle={`Now ${localTimeSummary(item, now)}`}
                trailing={item === value ? <Icon name="check" size={20} color="primary" /> : undefined}
                showChevron={false}
                accessibilityLabel={`${zoneLabel(item)}, now ${localTimeSummary(item, now)}${
                  item === value ? ', selected' : ''
                }`}
                onPress={() => {
                  onChange(item);
                  close();
                }}
              />
            )}
          />
        </Screen>
      </Modal>
    </View>
  );
}
