/** Zod schemas of the two small forms (email, code) so React Hook Form shows the same wording the unit tests pin. */
import { z } from 'zod';

import { isValidCode, isValidEmail } from './emailLinking';

export const EMAIL_FORM_ERROR = 'Enter a valid email address, like name@example.com.';
export const CODE_FORM_ERROR = 'Enter the 6-digit code from the email.';

export const emailFormSchema = z.object({
  email: z.string().refine(isValidEmail, { message: EMAIL_FORM_ERROR }),
});
export type EmailFormValues = z.infer<typeof emailFormSchema>;

export const codeFormSchema = z.object({
  code: z.string().refine(isValidCode, { message: CODE_FORM_ERROR }),
});
export type CodeFormValues = z.infer<typeof codeFormSchema>;
