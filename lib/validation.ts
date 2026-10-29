import { z } from "zod"

export const usernameSchema = z
  .string()
  .trim()
  .min(3, "Username must be at least 3 characters")
  .max(64, "Username must be at most 64 characters")
  .regex(/^[a-zA-Z0-9_.-]+$/, "Use letters, numbers, dot, dash or underscore")

export const passwordSchema = z
  .string()
  .min(8, "Password must be at least 8 characters")
  .max(256, "Password is too long")

export const roleSchema = z.enum(["admin", "user"])

/** Shared shape returned by every form Server Action. */
export type ActionState = {
  ok?: boolean
  error?: string
  message?: string
  fieldErrors?: Record<string, string[] | undefined>
  /** Non-secret values echoed back so a form can keep them after a failed submit. */
  values?: Record<string, string>
}

export function fieldErrors(error: z.ZodError): ActionState {
  return {
    error: "Please fix the highlighted fields",
    fieldErrors: z.flattenError(error).fieldErrors as Record<string, string[]>,
  }
}
