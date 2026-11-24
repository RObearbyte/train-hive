import { Text } from '@/ui';

import { confirmEmailLink, requestEmailLink, resendEmailLink } from '../api/emailAuth';
import { linkSentMessage, maskEmail } from '../domain/emailLinking';
import { EmailCodeFlow, type EmailCodeActions, type EmailCodeCopy } from './EmailCodeFlow';

const LINK_ACTIONS: EmailCodeActions = {
  request: requestEmailLink,
  resend: resendEmailLink,
  confirm: confirmEmailLink,
};

const LINK_COPY: EmailCodeCopy = {
  emailHelper: 'Used only to sign you in again and to send you sign-in codes.',
  sendLabel: 'Send code',
  confirmLabel: 'Confirm email',
  sentMessage: (email) => linkSentMessage(maskEmail(email)),
};

/** The linking steps (email, then 6-digit code) plus the consent line; used by Profile and by the one-time page. */
export function SecureAccountForm({
  pendingEmail,
  testIdPrefix,
  onConfirmed,
}: {
  pendingEmail: string | null;
  testIdPrefix: string;
  onConfirmed?: () => void;
}) {
  return (
    <>
      <EmailCodeFlow
        actions={LINK_ACTIONS}
        copy={LINK_COPY}
        initialEmail={pendingEmail}
        onConfirmed={onConfirmed}
        testIdPrefix={testIdPrefix}
      />
      <Text variant="caption" color="textMuted">
        By adding your email you agree that we store it for this purpose (see the Privacy Notice). You can
        delete it by deleting your account.
      </Text>
    </>
  );
}
