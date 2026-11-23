import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { View } from 'react-native';

import { reportError } from '@/lib/logger';
import { Banner, Button, Text, TextField, useTheme } from '@/ui';

import { EmailAuthError } from '../api/emailAuth';
import {
  OTP_LENGTH,
  failureMessage,
  normalizeEmail,
  resendLabel,
  toCodeInput,
  type AuthFailureKind,
} from '../domain/emailLinking';
import { codeFormSchema, emailFormSchema, type CodeFormValues, type EmailFormValues } from '../domain/forms';
import { useCooldown } from '../hooks/useCooldown';

export type EmailCodeActions = {
  /** Sends the first code. */
  request: (email: string) => Promise<void>;
  resend: (email: string) => Promise<void>;
  /** Checks the code; resolves when it is accepted. */
  confirm: (email: string, code: string) => Promise<void>;
};

export type EmailCodeCopy = {
  emailHelper: string;
  sendLabel: string;
  confirmLabel: string;
  /** Shown above the code field once a code was requested; `email` is the address typed (may be unmasked). */
  sentMessage: (email: string) => string;
};

function failureOf(error: unknown): AuthFailureKind {
  return error instanceof EmailAuthError ? error.kind : 'unknown';
}

/**
 * Two steps shared by "Secure your account" and "I already have an account":
 * the email, then the 6-digit code with a resend countdown. What the steps DO
 * (link or sign in) comes in through `actions`; this component only collects
 * input and shows friendly errors. `initialEmail` resumes at the code step
 * (an address that is waiting for its code).
 */
export function EmailCodeFlow({
  actions,
  copy,
  initialEmail = null,
  onConfirmed,
  testIdPrefix,
}: {
  actions: EmailCodeActions;
  copy: EmailCodeCopy;
  initialEmail?: string | null;
  onConfirmed?: () => void;
  testIdPrefix: string;
}) {
  const { spacing } = useTheme();
  const [email, setEmail] = useState<string | null>(initialEmail);
  const [notice, setNotice] = useState<string | null>(null);
  const [resent, setResent] = useState(false);
  const cooldown = useCooldown();

  const emailForm = useForm<EmailFormValues>({
    resolver: zodResolver(emailFormSchema),
    defaultValues: { email: '' },
  });
  const codeForm = useForm<CodeFormValues>({
    resolver: zodResolver(codeFormSchema),
    defaultValues: { code: '' },
  });

  const request = useMutation<void, unknown, string>({
    mutationFn: actions.request,
    onSuccess: (_void, address) => {
      setEmail(address);
      setNotice(copy.sentMessage(address));
      setResent(false);
      codeForm.reset({ code: '' });
      cooldown.start();
    },
    onError: (error) => reportError('account.requestCode', error),
  });

  const resend = useMutation<void, unknown, string>({
    mutationFn: actions.resend,
    onSuccess: () => {
      setResent(true);
      cooldown.start();
    },
    onError: (error) => reportError('account.resendCode', error),
  });

  const confirm = useMutation<void, unknown, { address: string; code: string }>({
    mutationFn: ({ address, code }) => actions.confirm(address, code),
    onSuccess: () => onConfirmed?.(),
    onError: (error) => reportError('account.confirmCode', error),
  });

  const submitEmail = emailForm.handleSubmit(({ email: typed }) => {
    if (request.isPending) return;
    confirm.reset();
    request.mutate(normalizeEmail(typed));
  });

  const submitCode = codeForm.handleSubmit(({ code }) => {
    if (confirm.isPending || email === null) return;
    confirm.mutate({ address: email, code: code.trim() });
  });

  if (email === null) {
    const failure = request.error ? failureOf(request.error) : null;
    return (
      <View style={{ gap: spacing.md }}>
        {failure ? (
          <Banner tone={failure === 'rate_limited' ? 'warning' : 'error'} message={failureMessage(failure)} />
        ) : null}
        <Controller
          control={emailForm.control}
          name="email"
          render={({ field, fieldState }) => (
            <TextField
              ref={field.ref}
              label="Email"
              helper={copy.emailHelper}
              placeholder="name@example.com"
              value={field.value}
              onChangeText={(text) => {
                field.onChange(text);
                if (request.isError) request.reset();
              }}
              onBlur={field.onBlur}
              error={fieldState.error?.message}
              editable={!request.isPending}
              keyboardType="email-address"
              autoCapitalize="none"
              autoCorrect={false}
              autoComplete="email"
              textContentType="emailAddress"
              spellCheck={false}
              returnKeyType="send"
              onSubmitEditing={() => void submitEmail()}
              testID={`${testIdPrefix}-email-input`}
            />
          )}
        />
        <Button label={copy.sendLabel} fullWidth loading={request.isPending} onPress={() => void submitEmail()} />
      </View>
    );
  }

  const confirmFailure = confirm.error ? failureOf(confirm.error) : null;
  const resendFailure = resend.error ? failureOf(resend.error) : null;
  const busy = confirm.isPending || resend.isPending;
  // A wrong code belongs to the field; everything else is a banner.
  const codeError =
    confirmFailure === 'invalid_code' || confirmFailure === 'no_account' ? failureMessage(confirmFailure) : undefined;
  const bannerFailure =
    resendFailure ?? (confirmFailure !== null && codeError === undefined ? confirmFailure : null);

  return (
    <View style={{ gap: spacing.md }}>
      {notice ? <Banner tone="info" message={notice} /> : null}
      {resent && !resendFailure ? <Banner tone="success" message="We sent a new code. The old one no longer works." /> : null}
      {bannerFailure ? (
        <Banner
          tone={bannerFailure === 'rate_limited' ? 'warning' : 'error'}
          message={failureMessage(bannerFailure)}
        />
      ) : null}
      <Controller
        control={codeForm.control}
        name="code"
        render={({ field, fieldState }) => (
          <TextField
            ref={field.ref}
            label="Code from the email"
            helper={`${OTP_LENGTH} digits`}
            placeholder="123456"
            value={field.value}
            onChangeText={(text) => {
              field.onChange(toCodeInput(text));
              if (confirm.isError) confirm.reset();
            }}
            onBlur={field.onBlur}
            error={codeError ?? fieldState.error?.message}
            editable={!confirm.isPending}
            keyboardType="number-pad"
            autoComplete="one-time-code"
            textContentType="oneTimeCode"
            autoCorrect={false}
            maxLength={OTP_LENGTH + 4}
            returnKeyType="done"
            onSubmitEditing={() => void submitCode()}
            testID={`${testIdPrefix}-code-input`}
          />
        )}
      />
      <Button label={copy.confirmLabel} fullWidth loading={confirm.isPending} onPress={() => void submitCode()} />
      <Button
        label={resendLabel(cooldown.remaining)}
        variant="secondary"
        size="sm"
        fullWidth
        disabled={cooldown.remaining > 0 || busy}
        loading={resend.isPending}
        onPress={() => {
          if (!resend.isPending) resend.mutate(email);
        }}
      />
      <Button
        label="Use a different email"
        variant="ghost"
        size="sm"
        fullWidth
        disabled={busy}
        onPress={() => {
          setEmail(null);
          setNotice(null);
          request.reset();
          resend.reset();
          confirm.reset();
        }}
      />
      <Text variant="caption" color="textMuted">
        Not there after a few minutes? Check your spam folder.
      </Text>
    </View>
  );
}
