import { zodResolver } from '@hookform/resolvers/zod';
import { Controller, useForm } from 'react-hook-form';
import { View } from 'react-native';

import {
  DISPLAY_NAME_MAX,
  displayNameFormSchema,
  type DisplayNameFormValues,
} from '@/features/onboarding/domain/displayName';
import { userMessage } from '@/lib/errors';
import { Banner, Button, TextField, useTheme } from '@/ui';

import { useUpdateDisplayName } from '../hooks/useUpdateDisplayName';

export function DisplayNameForm({
  currentName,
  onDone,
}: {
  currentName: string;
  onDone: () => void;
}) {
  const { spacing } = useTheme();
  const update = useUpdateDisplayName();
  const { control, handleSubmit, setError } = useForm<DisplayNameFormValues>({
    resolver: zodResolver(displayNameFormSchema),
    defaultValues: { displayName: currentName },
  });

  const submit = handleSubmit(({ displayName }) => {
    if (update.isPending) return;
    if (displayName === currentName) {
      onDone();
      return;
    }
    update.mutate(displayName, {
      onSuccess: onDone,
      onError: (error) => {
        if (error.code === 'validation_failed' || error.code === 'invalid_display_name') {
          setError('displayName', { message: userMessage('invalid_display_name') });
        }
      },
    });
  });

  const error = update.error;
  const showBanner =
    error !== null && error.code !== 'validation_failed' && error.code !== 'invalid_display_name';

  return (
    <View style={{ gap: spacing.md }}>
      {showBanner ? <Banner tone="error" message={userMessage(error.code, error.field)} /> : null}
      <Controller
        control={control}
        name="displayName"
        render={({ field, fieldState }) => (
          <TextField
            ref={field.ref}
            label="Your name"
            helper="Shown to your community"
            value={field.value}
            onChangeText={field.onChange}
            onBlur={field.onBlur}
            error={fieldState.error?.message}
            editable={!update.isPending}
            autoCapitalize="words"
            autoCorrect={false}
            autoComplete="name"
            maxLength={DISPLAY_NAME_MAX * 2}
            returnKeyType="done"
            onSubmitEditing={() => void submit()}
          />
        )}
      />
      <View style={{ flexDirection: 'row', gap: spacing.sm }}>
        <Button
          label="Save"
          onPress={() => void submit()}
          loading={update.isPending}
          style={{ flex: 1 }}
        />
        <Button
          label="Cancel"
          variant="ghost"
          onPress={onDone}
          disabled={update.isPending}
          style={{ flex: 1 }}
        />
      </View>
    </View>
  );
}
