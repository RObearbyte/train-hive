import { zodResolver } from '@hookform/resolvers/zod';
import { useState } from 'react';
import { Controller, useForm, useWatch } from 'react-hook-form';
import { Switch, View } from 'react-native';

import { Banner, Button, Text, TextField, useTheme } from '@/ui';

import {
  ANONYMOUS_HELPER,
  EVENT_POST_MAX,
  counterText,
  feedErrorMessage,
  postFormSchema,
  toPostBody,
  type PostFormValues,
} from '../domain/feed';

type Props = {
  label: string;
  submitLabel: string;
  /** Sends the trimmed text (and whether it is anonymous). Rejects with the AppError when the server refuses. */
  onSubmit: (body: string, anonymous: boolean) => Promise<unknown>;
  /** Show the "Post anonymously" switch (members only; off by default). */
  allowAnonymous?: boolean;
  /** Called after a successful send (e.g. to close a reply box). */
  onDone?: () => void;
  onCancel?: () => void;
  autoFocus?: boolean;
};

/**
 * One text box with a character counter. The text is trimmed before it is
 * sent and kept (with the error) when the send fails, so nothing typed is lost.
 * The anonymous switch starts off and goes back off after a send.
 */
export function PostComposer({
  label,
  submitLabel,
  onSubmit,
  allowAnonymous = false,
  onDone,
  onCancel,
  autoFocus,
}: Props) {
  const { spacing, colors } = useTheme();
  const { control, handleSubmit, reset } = useForm<PostFormValues>({
    defaultValues: { body: '' },
    resolver: zodResolver(postFormSchema),
    mode: 'onSubmit',
  });
  const body = useWatch({ control, name: 'body' });
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [anonymous, setAnonymous] = useState(false);
  const sendAnonymously = allowAnonymous && anonymous;

  const submit = handleSubmit(async (values) => {
    if (sending) return;
    setSending(true);
    setError(null);
    try {
      await onSubmit(toPostBody(values), sendAnonymously);
      reset({ body: '' });
      setAnonymous(false);
      onDone?.();
    } catch (failure) {
      setError(feedErrorMessage(failure, 'post', sendAnonymously));
    } finally {
      setSending(false);
    }
  });

  return (
    <View style={{ gap: spacing.sm }}>
      <Controller
        control={control}
        name="body"
        render={({ field, fieldState }) => (
          <TextField
            ref={field.ref}
            label={label}
            value={field.value}
            onChangeText={(text) => {
              field.onChange(text);
              if (error !== null) setError(null);
            }}
            onBlur={field.onBlur}
            error={fieldState.error?.message}
            helper={counterText(body)}
            editable={!sending}
            multiline
            numberOfLines={3}
            textAlignVertical="top"
            autoCapitalize="sentences"
            autoFocus={autoFocus}
            maxLength={EVENT_POST_MAX * 2}
            style={{ minHeight: 88 }}
          />
        )}
      />
      {allowAnonymous ? (
        <View style={{ gap: spacing.xxs }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm }}>
            <Text variant="label" style={{ flex: 1 }}>
              Post anonymously
            </Text>
            <Switch
              value={anonymous}
              disabled={sending}
              onValueChange={setAnonymous}
              accessibilityLabel="Post anonymously"
              trackColor={{ false: colors.borderStrong, true: colors.primary }}
              thumbColor={colors.surface}
            />
          </View>
          <Text variant="caption" color="textMuted">
            {ANONYMOUS_HELPER}
          </Text>
        </View>
      ) : null}
      {error !== null ? <Banner tone="error" message={error} /> : null}
      <View style={{ flexDirection: 'row', gap: spacing.sm, justifyContent: 'flex-end' }}>
        {onCancel ? (
          <Button label="Cancel" variant="ghost" size="sm" onPress={onCancel} disabled={sending} />
        ) : null}
        <Button label={submitLabel} size="sm" loading={sending} onPress={() => void submit()} />
      </View>
    </View>
  );
}
