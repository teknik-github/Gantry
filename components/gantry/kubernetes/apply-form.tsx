"use client"

import * as React from "react"
import { useActionState } from "react"
import { FileUpIcon } from "lucide-react"
import { toast } from "sonner"

import { applyManifest, type ApplyState } from "@/app/(app)/kubernetes/actions"
import { Mono } from "@/components/gantry/ui"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Textarea } from "@/components/ui/textarea"
import { useI18n } from "@/lib/i18n/client"
import { cn } from "@/lib/utils"

export const EXAMPLE_MANIFEST = `apiVersion: apps/v1
kind: Deployment
metadata:
  name: hello
  labels:
    app: hello
spec:
  replicas: 1
  selector:
    matchLabels:
      app: hello
  template:
    metadata:
      labels:
        app: hello
    spec:
      containers:
        - name: web
          image: nginx:alpine
          ports:
            - containerPort: 80
---
apiVersion: v1
kind: Service
metadata:
  name: hello
spec:
  selector:
    app: hello
  ports:
    - port: 80
      targetPort: 80
`

/**
 * YAML editor for "Apply manifest". Bound with `action=` so it works before
 * hydration; the submitted manifest comes back in the state and is used as
 * the default after React resets the form.
 */
export function ApplyForm({
  environmentId,
  namespaces,
  defaultNamespace,
}: {
  environmentId: number
  namespaces: string[]
  defaultNamespace: string
}) {
  const { t, rich } = useI18n()
  const k = t.kubernetes.apply
  const uid = React.useId()
  const [state, formAction, pending] = useActionState<ApplyState, FormData>(applyManifest, {})
  // React resets the form after the action (Radix controls follow): the
  // submitted choices come back in `values` and become the defaults.
  const values = state.values ?? {}
  const namespace = values.namespace || defaultNamespace
  // Only for the button label; follows the switch and each new result.
  const [dryRun, setDryRun] = React.useState(false)
  const [shownState, setShownState] = React.useState(state)
  if (shownState !== state) {
    setShownState(state)
    setDryRun(state.values?.dry_run === "on")
  }
  React.useEffect(() => {
    if (state.error && !state.fieldErrors) toast.error(state.error)
    else if (state.ok && state.message) {
      if (state.results?.some((r) => r.status === "error")) toast.warning(state.message)
      else toast.success(state.message)
    }
  }, [state])
  const errs = state.fieldErrors ?? {}
  const options = namespaces.includes(namespace) ? namespaces : [namespace, ...namespaces]

  return (
    <div className="flex flex-col gap-6 px-4 lg:px-6">
      <form action={formAction} className="flex flex-col gap-5">
        <input type="hidden" name="environment" value={environmentId} />
        <FieldGroup>
          <Field data-invalid={errs.namespace ? true : undefined} className="max-w-sm">
            <FieldLabel htmlFor={`${uid}-namespace`}>{t.kubernetes.common.namespace}</FieldLabel>
            <Select key={namespace} name="namespace" defaultValue={namespace}>
              <SelectTrigger id={`${uid}-namespace`} className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {options.map((ns) => (
                  <SelectItem key={ns} value={ns}>
                    {ns}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <FieldDescription>{rich(k.namespaceHelp, { field: <Mono>metadata.namespace</Mono> })}</FieldDescription>
            <FieldError>{errs.namespace?.[0]}</FieldError>
          </Field>

          <Field data-invalid={errs.manifest ? true : undefined}>
            <FieldLabel htmlFor={`${uid}-manifest`}>{k.manifest}</FieldLabel>
            <Textarea
              id={`${uid}-manifest`}
              name="manifest"
              defaultValue={values.manifest ?? EXAMPLE_MANIFEST}
              className="max-h-[70vh] min-h-96 font-mono text-xs leading-relaxed md:text-xs"
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
              wrap="off"
              required
              aria-invalid={errs.manifest ? true : undefined}
            />
            <FieldDescription>
              {rich(k.manifestHelp, {
                separator: <Mono>---</Mono>,
                manager: <Mono>gantry</Mono>,
                command: <Mono>kubectl apply --server-side</Mono>,
              })}
            </FieldDescription>
            <FieldError>{errs.manifest?.[0]}</FieldError>
          </Field>

          <Field orientation="horizontal">
            <Switch
              key={`dry-run-${values.dry_run}`}
              id={`${uid}-dry-run`}
              name="dry_run"
              defaultChecked={values.dry_run === "on"}
              onCheckedChange={setDryRun}
            />
            <FieldLabel htmlFor={`${uid}-dry-run`} className="font-normal">
              {k.dryRunLabel}
            </FieldLabel>
          </Field>
          <Field orientation="horizontal">
            <Switch
              key={`force-${values.force}`}
              id={`${uid}-force`}
              name="force"
              defaultChecked={values.force === "on"}
            />
            <FieldLabel htmlFor={`${uid}-force`} className="font-normal">
              {k.forceLabel}
            </FieldLabel>
          </Field>

          {state.error && state.fieldErrors ? <FieldError>{state.error}</FieldError> : null}

          <Field orientation="horizontal">
            <Button type="submit" disabled={pending}>
              <FileUpIcon data-icon="inline-start" />
              {pending ? k.applying : dryRun ? k.dryRun : t.common.actions.apply}
            </Button>
          </Field>
        </FieldGroup>
      </form>

      {state.results?.length ? <ApplyResults results={state.results} /> : null}
    </div>
  )
}

function ApplyResults({ results }: { results: NonNullable<ApplyState["results"]> }) {
  const { t } = useI18n()
  return (
    <div className="overflow-hidden rounded-lg border" data-testid="apply-results">
      <Table>
        <TableHeader className="bg-muted">
          <TableRow>
            <TableHead>{t.kubernetes.apply.object}</TableHead>
            <TableHead>{t.kubernetes.common.namespace}</TableHead>
            <TableHead>{t.kubernetes.apply.result}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {results.map((r) => (
            <TableRow key={r.index}>
              <TableCell>
                <Mono>
                  {r.kind}/{r.name}
                </Mono>
              </TableCell>
              <TableCell className="text-muted-foreground">{r.namespace ?? "—"}</TableCell>
              <TableCell className="whitespace-normal">
                <div className="flex flex-col items-start gap-1">
                  <Badge
                    variant="outline"
                    className={cn(r.status === "error" ? "text-destructive" : "text-emerald-600")}
                  >
                    {r.status}
                  </Badge>
                  {r.message ? <span className="text-xs text-destructive">{r.message}</span> : null}
                </div>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  )
}
