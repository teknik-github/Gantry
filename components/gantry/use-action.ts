"use client"

import { startTransition, useTransition } from "react"
import { toast } from "sonner"

import type { ActionState } from "@/lib/validation"

/** Runs a Server Action in a transition and reports the outcome as a toast. */
export function useRunAction() {
  const [pending, start] = useTransition()

  function run(fn: () => Promise<ActionState>, success?: string) {
    return new Promise<boolean>((resolve) => {
      start(async () => {
        try {
          const res = await fn()
          if (res.error) {
            toast.error(res.error)
            resolve(false)
          } else {
            if (res.message || success) toast.success(res.message ?? success)
            resolve(true)
          }
        } catch {
          toast.error("Request failed. Check your connection.")
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
