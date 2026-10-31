"use client"

import * as React from "react"

import { useRunAction } from "@/components/gantry/use-action"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog"
import { useI18n } from "@/lib/i18n/client"
import type { ActionState } from "@/lib/validation"

/**
 * Confirmation dialog for a Server Action. Pass `children` as the trigger, or
 * control it with `open`/`onOpenChange` (e.g. from a dropdown menu item, which
 * would otherwise unmount the dialog when the menu closes).
 */
export function ConfirmAction({
  children,
  open: openProp,
  onOpenChange,
  title,
  description,
  confirmLabel,
  destructive = true,
  onConfirm,
  extra,
}: {
  children?: React.ReactNode
  open?: boolean
  onOpenChange?: (open: boolean) => void
  title: string
  description: React.ReactNode
  confirmLabel?: string
  destructive?: boolean
  onConfirm: () => Promise<ActionState>
  /** Optional extra controls (e.g. a "force" checkbox). */
  extra?: React.ReactNode
}) {
  const [openState, setOpenState] = React.useState(false)
  const open = openProp ?? openState
  const setOpen = onOpenChange ?? setOpenState
  const [pending, run] = useRunAction()
  const { t } = useI18n()

  return (
    <AlertDialog open={open} onOpenChange={(o) => !pending && setOpen(o)}>
      {children ? <AlertDialogTrigger asChild>{children}</AlertDialogTrigger> : null}
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        {extra}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>{t.common.actions.cancel}</AlertDialogCancel>
          <AlertDialogAction
            variant={destructive ? "destructive" : "default"}
            disabled={pending}
            onClick={async (e) => {
              e.preventDefault()
              if (await run(onConfirm)) setOpen(false)
            }}
          >
            {pending ? t.common.status.working : (confirmLabel ?? t.common.actions.confirm)}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
