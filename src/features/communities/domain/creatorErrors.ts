/**
 * Friendly handling of every answer `preview_creator_code` and
 * `create_community_with_code` can give (docs/API_CONTRACT.md, C1), decided in
 * one place so the screens only render the result.
 *
 * `target` says where the message goes: on the field it is about, or in a
 * banner when it is about the request as a whole.
 */
import { userMessage } from '@/lib/errors';

export type CreatorErrorTarget = 'code' | 'name' | 'timezone' | 'displayName' | 'banner';

export type CreatorErrorView = {
  target: CreatorErrorTarget;
  message: string;
  tone: 'error' | 'warning';
  /** The code itself is no good any more: offer "Use another code". */
  codeProblem: boolean;
};

const CODE_MESSAGES: Record<string, string> = {
  invalid_code: 'That creator code is not valid. Check it and try again.',
  expired: 'This creator code has expired. Ask for a new one.',
  revoked: 'This creator code is no longer active. Ask for a new one.',
  exhausted: 'This creator code has already been used.',
};

/** True for answers that are about the code itself. */
export function isCreatorCodeProblem(code: string): boolean {
  return Object.hasOwn(CODE_MESSAGES, code);
}

export function mapCreatorError(error: { code: string; field?: string | undefined }): CreatorErrorView {
  const { code, field } = error;

  if (isCreatorCodeProblem(code)) {
    return { target: 'code', message: CODE_MESSAGES[code], tone: 'error', codeProblem: true };
  }
  if (code === 'rate_limited') {
    return {
      target: 'banner',
      message: 'Too many attempts. Wait 15 minutes, then try again.',
      tone: 'warning',
      codeProblem: false,
    };
  }
  if (code === 'stale_data') {
    return { target: 'banner', message: userMessage('stale_data'), tone: 'warning', codeProblem: false };
  }
  if (code === 'validation_failed') {
    if (field === 'name') {
      return {
        target: 'name',
        message: 'Enter a community name of 1 to 80 characters.',
        tone: 'error',
        codeProblem: false,
      };
    }
    if (field === 'timezone') {
      return {
        target: 'timezone',
        message: 'Choose a time zone from the list.',
        tone: 'error',
        codeProblem: false,
      };
    }
    if (field === 'display_name') {
      return {
        target: 'displayName',
        message: userMessage('invalid_display_name'),
        tone: 'error',
        codeProblem: false,
      };
    }
  }
  // community_limit_reached, network_error, not_authenticated, validation_failed:request_id,
  // anything unknown: the shared friendly text, in a banner.
  return {
    target: 'banner',
    message: userMessage(code, field),
    tone: 'error',
    codeProblem: false,
  };
}
