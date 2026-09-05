import { z } from 'zod';

export const emailField = z
  .string()
  .trim()
  .toLowerCase()
  .min(3)
  .max(190)
  .email('Enter a valid email address.');

export const passwordField = z.string().min(1, 'Enter your password.').max(128);

export const loginSchema = z.object({
  email: emailField,
  password: passwordField,
  /** Opt-in device trust; the refresh cookie lifetime is unchanged either way. */
  rememberDevice: z.boolean().optional().default(false),
});

export const changePasswordSchema = z.object({
  currentPassword: passwordField,
  newPassword: z.string().min(10, 'Use at least 10 characters.').max(128),
  signOutOtherDevices: z.boolean().optional().default(true),
});

export const forgotPasswordSchema = z.object({
  email: emailField,
});

export const resetPasswordSchema = z.object({
  token: z.string().min(20).max(200),
  newPassword: z.string().min(10, 'Use at least 10 characters.').max(128),
});

export type LoginInput = z.infer<typeof loginSchema>;
export type ChangePasswordInput = z.infer<typeof changePasswordSchema>;
export type ForgotPasswordInput = z.infer<typeof forgotPasswordSchema>;
export type ResetPasswordInput = z.infer<typeof resetPasswordSchema>;
