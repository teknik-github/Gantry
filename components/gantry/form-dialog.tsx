"use client"

import * as React from "react"
import { useActionState } from "react"
import { toast } from "sonner"

import { submitKeepingValues } from "@/components/gantry/use-action"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { FieldError } from "@/components/ui/field"
import type { ActionState } from "@/lib/validation"

/**
 * Dialog with a form bound to a Server Action via useActionState. Closes and
 * toasts on success; field errors are passed to `children` for rendering.
 */
export function FormDialog({
  trigger,
  title,
  description,
  submitLabel = "Save",
  action,
  children,
  className,
}: {
  trigger: React.ReactNode
  title: string
  description?: React.ReactNode
  submitLabel?: string
  action: (prev: ActionState, formData: FormData) => Promise<ActionState>
  children: (errors: Record<string, string[] | undefined>) => React.ReactNode
  className?: string
}) {
  const [open, setOpen] = React.useState(false)
  // Remount the form each time the dialog opens so stale errors disappear.
  const [formKey, setFormKey] = React.useState(0)

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o)
        if (o) setFormKey((k) => k + 1)
      }}
    >
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent className={className}>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description ? <DialogDescription>{description}</DialogDescription> : null}
        </DialogHeader>
        <DialogForm
          key={formKey}
          action={action}
          submitLabel={submitLabel}
          onSuccess={() => setOpen(false)}
        >
          {children}
        </DialogForm>
      </DialogContent>
    </Dialog>
  )
}

function DialogForm({
  action,
  submitLabel,
  onSuccess,
  children,
}: {
  action: (prev: ActionState, formData: FormData) => Promise<ActionState>
  submitLabel: string
  onSuccess: () => void
  children: (errors: Record<string, string[] | undefined>) => React.ReactNode
}) {
  const [state, formAction, pending] = useActionState(async (prev: ActionState, fd: FormData) => {
    const res = await action(prev, fd)
    if (res.ok) {
      toast.success(res.message ?? "Done")
      onSuccess()
    }
    return res
  }, {})

  return (
    <form method="post" onSubmit={submitKeepingValues(formAction)} className="flex flex-col gap-5">
      {children(state.fieldErrors ?? {})}
      {state.error && !state.fieldErrors ? <FieldError>{state.error}</FieldError> : null}
      <DialogFooter>
        <DialogClose asChild>
          <Button type="button" variant="outline" disabled={pending}>
            Cancel
          </Button>
        </DialogClose>
        <Button type="submit" disabled={pending}>
          {pending ? "Working…" : submitLabel}
        </Button>
      </DialogFooter>
    </form>
  )
}
