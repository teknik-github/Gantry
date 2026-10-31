"use client"

import { startTransition, useTransition } from "react"
import { toast } from "sonner"

import { useI18n } from "@/lib/i18n/client"
import { translateKnown } from "@/lib/i18n/known-messages"
import type { ActionState } from "@/lib/validation"

/** Runs a Server Action in a transition and reports the outcome as a toast. */
export function useRunAction() {
  const [pending, start] = useTransition()
  const i18n = useI18n()

  function run(fn: () => Promise<ActionState>, success?: string) {
    return new Promise<boolean>((resolve) => {
      start(async () => {
        try {
          const res = await fn()
          if (res.error) {
            toast.error(translateKnown(i18n, res.error))
            resolve(false)
          } else {
            if (res.message || success) toast.success(res.message ?? success)
            resolve(true)
          }
        } catch {
          toast.error(i18n.t.common.errors.requestFailed)
          resolve(false)
        }
      })
    })
  }

  return [pending, run] as const
}

/**
 * onSubmit handler that dispatches a useActionState action without React's
 * automatic form reset, so inputs survive a validation error.
 */
export function submitKeepingValues(dispatch: (formData: FormData) => void) {
  return (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const formData = new FormData(event.currentTarget)
    startTransition(() => dispatch(formData))
  }
}
