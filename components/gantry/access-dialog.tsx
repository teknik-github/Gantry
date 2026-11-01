"use client"

import * as React from "react"

import { FormDialog } from "@/components/gantry/form-dialog"
import { Badge } from "@/components/ui/badge"
import { Checkbox } from "@/components/ui/checkbox"
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { ENVIRONMENT_ROLES, ROLE_LABELS, type EnvironmentRole } from "@/lib/permissions"
import type { ActionState } from "@/lib/validation"

// Environment access, shared by the Environments page (users of one
// environment) and the Users page (environments of one user).

type AccessOption = { id: number; label: string }
type AccessGrant = { id: number; role: EnvironmentRole }

/**
 * Checkbox list with a role per checked option, bound to a Server Action:
 * submits `id` plus one `fieldName` value "<option id>:<role>" per checked
 * option. New grants start as operator, what every grant allowed before
 * roles existed.
 */
export function AccessDialog({
  trigger,
  title,
  description,
  action,
  id,
  fieldName,
  options,
  selected,
  emptyMessage,
}: {
  trigger: React.ReactNode
  title: string
  description: React.ReactNode
  action: (prev: ActionState, formData: FormData) => Promise<ActionState>
  id: number
  fieldName: string
  options: AccessOption[]
  selected: AccessGrant[]
  emptyMessage: string
}) {
  return (
    <FormDialog trigger={trigger} title={title} description={description} submitLabel="Save" action={action}>
      {() => (
        <>
          <input type="hidden" name="id" value={id} />
          <AccessChecklist fieldName={fieldName} options={options} initial={selected} emptyMessage={emptyMessage} />
        </>
      )}
    </FormDialog>
  )
}

function AccessChecklist({
  fieldName,
  options,
  initial,
  emptyMessage,
}: {
  fieldName: string
  options: AccessOption[]
  initial: AccessGrant[]
  emptyMessage: string
}) {
  // Unique ids: Next keeps recently visited pages hidden in the DOM.
  const uid = React.useId()
  const [roles, setRoles] = React.useState(() => new Map(initial.map((g) => [g.id, g.role])))
  if (options.length === 0) return <p className="text-sm text-muted-foreground">{emptyMessage}</p>
  const update = (id: number, role: EnvironmentRole | null) =>
    setRoles((prev) => {
      const next = new Map(prev)
      if (role) next.set(id, role)
      else next.delete(id)
      return next
    })
  return (
    <div className="flex max-h-80 flex-col gap-3 overflow-y-auto" role="group" aria-label="Access">
      {options.map((o) => {
        const role = roles.get(o.id)
        return (
          <Field key={o.id} orientation="horizontal" className="min-h-8">
            <Checkbox
              id={`${uid}-${o.id}`}
              checked={role !== undefined}
              onCheckedChange={(value) => update(o.id, value === true ? (role ?? "operator") : null)}
            />
            <FieldLabel htmlFor={`${uid}-${o.id}`} className="font-normal">
              {o.label}
            </FieldLabel>
            {role ? (
              <>
                <Select value={role} onValueChange={(r) => update(o.id, r as EnvironmentRole)}>
                  <SelectTrigger size="sm" className="ml-auto w-32" aria-label={`Role for ${o.label}`}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {ENVIRONMENT_ROLES.map((r) => (
                      <SelectItem key={r} value={r}>
                        {ROLE_LABELS[r]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <input type="hidden" name={fieldName} value={`${o.id}:${role}`} />
              </>
            ) : null}
          </Field>
        )
      })}
      <FieldDescription>
        Viewer: read-only. Operator: start, stop, restart, logs. Manager: everything in the environment.
      </FieldDescription>
    </div>
  )
}

export function RoleBadge({ name, role }: { name: string; role: EnvironmentRole }) {
  return (
    <Badge variant="secondary" className="gap-1">
      {name}{" "}
      <span className="font-normal text-muted-foreground">{ROLE_LABELS[role].toLowerCase()}</span>
    </Badge>
  )
}
