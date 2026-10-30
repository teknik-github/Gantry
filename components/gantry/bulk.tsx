"use client"

import * as React from "react"

import { ConfirmAction } from "@/components/gantry/confirm-button"
import { useRunAction } from "@/components/gantry/use-action"
import { Button } from "@/components/ui/button"
import type { ActionState } from "@/lib/validation"

/** A bulk action that runs straight away (start, stop, ...). Clears the selection on success. */
export function BulkButton({
  label,
  icon,
  count,
  onRun,
  onDone,
}: {
  label: string
  icon: React.ReactNode
  /** Selected items this action applies to; disabled at 0. */
  count: number
  onRun: () => Promise<ActionState>
  onDone: () => void
}) {
  const [pending, run] = useRunAction()
  return (
    <Button
      size="sm"
      variant="outline"
      disabled={pending || count === 0}
      onClick={async () => {
        if (await run(onRun)) onDone()
      }}
    >
      {icon}
      {label}
      {count ? <span className="text-muted-foreground tabular-nums">{count}</span> : null}
    </Button>
  )
}

const MAX_NAMES = 10

/** A bulk action behind a confirmation that lists what it touches (destructive by default). */
export function BulkConfirm({
  label,
  icon,
  title,
  description,
  names,
  warning,
  extra,
  destructive = true,
  onConfirm,
  onDone,
}: {
  label: string
  icon: React.ReactNode
  title: string
  description: string
  names: string[]
  /** e.g. "2 of them are in use and will fail". */
  warning?: string | null
  extra?: React.ReactNode
  destructive?: boolean
  onConfirm: () => Promise<ActionState>
  onDone: () => void
}) {
  return (
    <ConfirmAction
      title={title}
      confirmLabel={label}
      destructive={destructive}
      description={
        <span className="flex flex-col gap-2">
          <span>{description}</span>
          <span className="max-h-40 overflow-y-auto rounded-md border bg-muted/40 px-3 py-2 font-mono text-xs" data-testid="bulk-names">
            {names.slice(0, MAX_NAMES).map((n) => (
              <span key={n} className="block truncate">
                {n}
              </span>
            ))}
            {names.length > MAX_NAMES ? (
              <span className="block text-muted-foreground">and {names.length - MAX_NAMES} more</span>
            ) : null}
          </span>
          {warning ? <span className="text-amber-600 dark:text-amber-400">{warning}</span> : null}
        </span>
      }
      extra={extra}
      onConfirm={async () => {
        const res = await onConfirm()
        if (!res.error) onDone()
        return res
      }}
    >
      <Button size="sm" variant="outline" className={destructive ? "text-destructive" : undefined} disabled={names.length === 0}>
        {icon}
        {label}
        <span className="tabular-nums opacity-70">{names.length}</span>
      </Button>
    </ConfirmAction>
  )
}
