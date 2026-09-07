import { z } from "zod";

/**
 * Form schemas, kept in one file so the API's constraints are stated once.
 *
 * These MIRROR the API's rules (min 8 / max 128 on a password, 2..100 on a
 * name) and exist to fail fast in the browser — not to enforce anything. The
 * API re-validates every field, runs the password policy the browser cannot
 * (common passwords, sequences, the email and app name appearing inside the
 * password) and is the only thing standing between a request and the database.
 *
 * When a rule changes in the API, change it here too. A stricter client than
 * server is a confusing form; a looser client than server is a round trip.
 */
export const emailSchema = z
  .email("Enter a valid email address")
  .max(254, "That email address is too long");

export const passwordSchema = z
  .string()
  .min(8, "Password must be at least 8 characters")
  .max(128, "Password cannot be longer than 128 characters");

export const nameSchema = z
  .string()
  .trim()
  .min(2, "Name must be at least 2 characters")
  .max(100, "Name cannot be more than 100 characters");

export const signInSchema = z.object({
  email: emailSchema,
  password: z.string().min(1, "Enter your password"),
  rememberMe: z.boolean(),
});
export type SignInValues = z.infer<typeof signInSchema>;

export const signUpSchema = z
  .object({
    name: nameSchema,
    email: emailSchema,
    password: passwordSchema,
    confirmPassword: z.string(),
  })
  // `path` puts the message on the confirm field rather than at form level,
  // which is where the user is looking when it fires.
  .refine((values) => values.password === values.confirmPassword, {
    path: ["confirmPassword"],
    message: "Passwords do not match",
  });
export type SignUpValues = z.infer<typeof signUpSchema>;

export const forgotPasswordSchema = z.object({ email: emailSchema });
export type ForgotPasswordValues = z.infer<typeof forgotPasswordSchema>;

export const resetPasswordSchema = z
  .object({
    password: passwordSchema,
    confirmPassword: z.string(),
  })
  .refine((values) => values.password === values.confirmPassword, {
    path: ["confirmPassword"],
    message: "Passwords do not match",
  });
export type ResetPasswordValues = z.infer<typeof resetPasswordSchema>;

export const profileSchema = z.object({ name: nameSchema });
export type ProfileValues = z.infer<typeof profileSchema>;
