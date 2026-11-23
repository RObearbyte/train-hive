import { zodResolver } from '@hookform/resolvers/zod';
import { Controller, useForm } from 'react-hook-form';
import { View } from 'react-native';

import type { InvitationCode } from '@/lib/database.types';
import { Banner, Button, SegmentedControl, Text, TextField, useTheme } from '@/ui';

import {
  EXPIRY_PRESET_OPTIONS,
  createInvitationFailure,
  createInvitationFormSchema,
  expiryHoursFromPreset,
  parseMaxUses,
  type CreateInvitationFormValues,
} from '../domain/createInvitation';
import { useCreateInvitation } from '../hooks/useInvitations';

export interface CreateInvitationFormProps {
  communityId: string;
  onCreated: (invitation: InvitationCode) => void;
}

export function CreateInvitationForm({ communityId, onCreated }: CreateInvitationFormProps) {
  const { spacing } = useTheme();
  const create = useCreateInvitation(communityId);
  const { control, handleSubmit, setError, reset } = useForm<CreateInvitationFormValues>({
    resolver: zodResolver(createInvitationFormSchema),
    defaultValues: { expiry: '7d', maxUses: '' },
  });

  const submit = handleSubmit((values) => {
    if (create.isPending) return;
    create.mutate(
      {
        // A duration: the server computes the expiry with its own clock (O1, Q2-10).
        expiresInHours: expiryHoursFromPreset(values.expiry),
        maxRedemptions: parseMaxUses(values.maxUses),
      },
      {
        onSuccess: (invitation) => {
          reset();
          onCreated(invitation);
        },
        onError: (error) => {
          const failure = createInvitationFailure(error);
          if (failure.field) setError(failure.field, { type: 'server', message: failure.message });
        },
      },
    );
  });

  const failure = create.error ? createInvitationFailure(create.error) : null;

  return (
    <View style={{ gap: spacing.md }}>
      <Text variant="heading">New invitation code</Text>
      <Text color="textMuted">Anyone with the code can join as a member.</Text>

      <View style={{ gap: spacing.xs }}>
        <Text variant="label">Expires</Text>
        <Controller
          control={control}
          name="expiry"
          render={({ field }) => (
            <SegmentedControl
              options={EXPIRY_PRESET_OPTIONS}
              value={field.value}
              onChange={field.onChange}
              accessibilityLabel="When the code expires"
            />
          )}
        />
      </View>

      <Controller
        control={control}
        name="maxUses"
        render={({ field, fieldState }) => (
          <TextField
            ref={field.ref}
            label="Maximum uses"
            helper="Optional. Leave empty for unlimited uses"
            value={field.value}
            onChangeText={field.onChange}
            onBlur={field.onBlur}
            error={fieldState.error?.message}
            editable={!create.isPending}
            keyboardType="number-pad"
            inputMode="numeric"
            maxLength={9}
            returnKeyType="done"
            onSubmitEditing={() => void submit()}
          />
        )}
      />

      {failure && failure.field === null ? <Banner tone="error" message={failure.message} /> : null}

      <Button
        label="Create code"
        icon="plus"
        onPress={() => void submit()}
        loading={create.isPending}
        fullWidth
      />
    </View>
  );
}
