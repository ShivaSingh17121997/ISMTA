/**
 * Sign-up rules. Pure, so the route stays thin and the rules are tested.
 *
 * Emails are compared trimmed and lower-cased: "Me@Mail.com" and "me@mail.com"
 * are one person, and letting both register would split one person's books,
 * broker connection and tax across two accounts.
 */

export interface RegistrationInput {
  email?: unknown;
  password?: unknown;
  name?: unknown;
}

export interface RegistrationOk {
  email: string;
  password: string;
  name: string;
}

/** The form an email is stored and looked up in. */
export function normaliseEmail(email: unknown): string {
  return String(email ?? '').trim().toLowerCase();
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Every problem with a sign-up, in words the form can show; empty when it is fine. */
export function registrationErrors(input: RegistrationInput, emailTaken: (email: string) => boolean): string[] {
  const errors: string[] = [];
  const email = normaliseEmail(input.email);
  const password = typeof input.password === 'string' ? input.password : '';
  const name = typeof input.name === 'string' ? input.name.trim() : '';

  if (!email) errors.push('Enter your email.');
  else if (!EMAIL.test(email) || email.length > 254) errors.push('That email does not look right.');
  else if (emailTaken(email)) errors.push('An account with this email already exists. Sign in instead.');

  // 10, the same as changing a password in Settings.
  if (password.length < 10) errors.push('Use a password of at least 10 characters.');
  else if (!/[A-Za-z]/.test(password) || !/\d/.test(password)) errors.push('Use at least one letter and one number in the password.');
  else if (password.toLowerCase() === email || password.toLowerCase() === email.split('@')[0]) {
    errors.push('The password cannot be your email.');
  }
  if (password.length > 200) errors.push('That password is too long.');

  if (name.length > 60) errors.push('Keep the name under 60 characters.');
  return errors;
}

/** The cleaned values to store, once `registrationErrors` is empty. */
export function cleanRegistration(input: RegistrationInput): RegistrationOk {
  const email = normaliseEmail(input.email);
  const name = typeof input.name === 'string' && input.name.trim() ? input.name.trim() : email.split('@')[0];
  return { email, password: String(input.password), name };
}
