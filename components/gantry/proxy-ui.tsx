"use client"

import * as React from "react"
import { useActionState } from "react"
import { CodeIcon, CopyIcon, PencilIcon, PlusIcon, RefreshCwIcon, SaveIcon, Trash2Icon, TriangleAlertIcon } from "lucide-react"
import { toast } from "sonner"

import { deleteHost, reapplyProxy, saveHost, saveSettings, setHostEnabled } from "@/app/(app)/proxy/actions"
import { columnHelperFor, DataTable } from "@/components/data-table"
import { ConfirmAction } from "@/components/gantry/confirm-button"
import { FormDialog } from "@/components/gantry/form-dialog"
import { Mono, StateBadge } from "@/components/gantry/ui"
import { submitKeepingValues, useRunAction } from "@/components/gantry/use-action"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import { TLS_MODE_KEYS, TLS_MODES, type ProxyMode, type ProxySettings, type TlsMode } from "@/lib/proxy"
import type { ActionState } from "@/lib/validation"

type Errors = Record<string, string[] | undefined>

const MODE_LABELS: Record<ProxyMode, { label: string; description: string }> = {
  off: { label: "Off", description: "Gantry doesn't route any domains." },
  internal: {
    label: "Built-in (Caddy)",
    description: "Gantry runs Caddy in a gantry-proxy container on this environment, with automatic HTTPS.",
  },
  external: {
    label: "External proxy",
    description: "You run Traefik, Nginx Proxy Manager or Caddy yourself; Gantry attaches targets to its network and gives you the config.",
  },
}

export function ProxySettingsCard({
  settings,
  status,
  lastError,
  appliedLabel,
}: {
  settings: ProxySettings
  status: { state: "missing" | "running" | "stopped"; httpPort?: number; httpsPort?: number } | null
  lastError: string | null
  appliedLabel: string | null
}) {
  const [state, formAction, pending] = useActionState<ActionState, FormData>(saveSettings, {})
  React.useEffect(() => {
    if (state.ok) toast.success(state.message ?? "Saved")
    else if (state.error && !state.fieldErrors) toast.error(state.error)
  }, [state])
  const values = state.values ?? {}
  const errs = state.fieldErrors ?? {}
  const [mode, setMode] = React.useState<ProxyMode>((values.mode as ProxyMode) || settings.mode)
  const [reapplying, run] = useRunAction()
  const uid = React.useId()

  return (
    <div className="px-4 lg:px-6">
      <Card>
        <CardHeader>
          <CardTitle className="flex flex-wrap items-center gap-2">
            Proxy
            {settings.mode === "internal" && status ? (
              <Badge
                variant="outline"
                className={status.state === "running" ? "border-emerald-500/50 text-emerald-700 dark:text-emerald-400" : "text-destructive"}
                data-testid="proxy-status"
              >
                {status.state === "running"
                  ? `running on :${status.httpPort} / :${status.httpsPort}`
                  : status.state === "stopped"
                    ? "stopped"
                    : "not created"}
              </Badge>
            ) : null}
          </CardTitle>
          <CardDescription>
            {MODE_LABELS[settings.mode].description}
            {appliedLabel ? ` Last applied ${appliedLabel}.` : ""}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {lastError ? (
            <div
              className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive"
              data-testid="proxy-error"
            >
              <TriangleAlertIcon className="mt-0.5 size-4 shrink-0" />
              <span className="break-words">{lastError}</span>
            </div>
          ) : null}
          {/* No automatic form reset: Radix Select/Checkbox would jump back to their first values. */}
          <form method="post" onSubmit={submitKeepingValues(formAction)} className="flex flex-col gap-4">
            <FieldGroup className="gap-4">
              <Field className="max-w-sm">
                <FieldLabel htmlFor={`${uid}-mode`}>Mode</FieldLabel>
                <Select name="mode" value={mode} onValueChange={(v) => setMode(v as ProxyMode)}>
                  <SelectTrigger id={`${uid}-mode`} className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {(Object.keys(MODE_LABELS) as ProxyMode[]).map((m) => (
                      <SelectItem key={m} value={m}>
                        {MODE_LABELS[m].label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <FieldDescription>{MODE_LABELS[mode].description}</FieldDescription>
              </Field>
              {mode === "internal" ? (
                <div className="grid gap-4 @3xl/main:grid-cols-3">
                  <Field data-invalid={errs.httpPort ? true : undefined}>
                    <FieldLabel htmlFor={`${uid}-http`}>HTTP port on the host</FieldLabel>
                    <Input id={`${uid}-http`} name="httpPort" type="number" min={1} max={65535} defaultValue={values.httpPort || settings.httpPort} />
                    <FieldError>{errs.httpPort?.[0]}</FieldError>
                  </Field>
                  <Field data-invalid={errs.httpsPort ? true : undefined}>
                    <FieldLabel htmlFor={`${uid}-https`}>HTTPS port on the host</FieldLabel>
                    <Input id={`${uid}-https`} name="httpsPort" type="number" min={1} max={65535} defaultValue={values.httpsPort || settings.httpsPort} />
                    <FieldError>{errs.httpsPort?.[0]}</FieldError>
                  </Field>
                  <Field data-invalid={errs.email ? true : undefined}>
                    <FieldLabel htmlFor={`${uid}-email`}>Let&apos;s Encrypt email</FieldLabel>
                    <Input id={`${uid}-email`} name="email" type="email" defaultValue={values.email ?? settings.email} placeholder="optional" />
                    <FieldError>{errs.email?.[0]}</FieldError>
                  </Field>
                  <FieldDescription className="@3xl/main:col-span-3">
                    Let&apos;s Encrypt only works with ports 80 and 443 reachable from the internet and DNS pointing at this
                    host. Other ports are fine for self-signed or HTTP-only hosts.
                  </FieldDescription>
                </div>
              ) : (
                <>
                  <input type="hidden" name="httpPort" value={settings.httpPort} />
                  <input type="hidden" name="httpsPort" value={settings.httpsPort} />
                  <input type="hidden" name="email" value={settings.email} />
                </>
              )}
              {mode === "external" ? (
                <Field data-invalid={errs.externalNetwork ? true : undefined} className="max-w-sm">
                  <FieldLabel htmlFor={`${uid}-net`}>Proxy network</FieldLabel>
                  <Input
                    id={`${uid}-net`}
                    name="externalNetwork"
                    defaultValue={values.externalNetwork ?? settings.externalNetwork}
                    placeholder="traefik_default"
                    autoComplete="off"
                  />
                  <FieldDescription>The Docker network your proxy container is attached to.</FieldDescription>
                  <FieldError>{errs.externalNetwork?.[0]}</FieldError>
                </Field>
              ) : (
                <input type="hidden" name="externalNetwork" value={settings.externalNetwork} />
              )}
            </FieldGroup>
            <div className="flex flex-wrap gap-2">
              <Button type="submit" disabled={pending}>
                <SaveIcon data-icon="inline-start" />
                {pending ? "Applying…" : "Save & apply"}
              </Button>
              {settings.mode !== "off" ? (
                <Button type="button" variant="outline" disabled={reapplying} onClick={() => run(reapplyProxy)}>
                  <RefreshCwIcon data-icon="inline-start" />
                  Re-apply
                </Button>
              ) : null}
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  )
}

type ContainerOption = { name: string; state: string; ports: number[] }

export type ProxyHostRow = {
  id: number
  domains: string[]
  target: string
  targetState: string
  port: number
  tls: TlsMode
  enabled: boolean
  snippets: { traefik: string; caddy: string; nginx: string }
}

const helper = columnHelperFor<ProxyHostRow>()

function buildColumns(mode: ProxyMode, containers: ContainerOption[]) {
  return helper.columns([
    helper.accessor((r) => r.domains.join(" "), {
      id: "domains",
      header: "Domains",
      enableHiding: false,
      cell: ({ row }) => (
        <div className="flex flex-col gap-0.5">
          {row.original.domains.map((d) => (
            <a
              key={d}
              href={`${row.original.tls === "off" ? "http" : "https"}://${d.replace(/^\*\./, "www.")}`}
              target="_blank"
              rel="noreferrer noopener"
              className="font-medium underline-offset-4 hover:underline"
            >
              {d}
            </a>
          ))}
        </div>
      ),
    }),
    helper.accessor("target", {
      header: "Target",
      cell: ({ row }) => (
        <div className="flex items-center gap-2">
          <Mono>
            {row.original.target}:{row.original.port}
          </Mono>
          {row.original.targetState === "missing" ? (
            <Badge variant="outline" className="text-destructive">
              missing
            </Badge>
          ) : (
            <StateBadge state={row.original.targetState} />
          )}
        </div>
      ),
    }),
    helper.accessor("tls", {
      header: "TLS",
      cell: ({ row }) => <Badge variant="outline">{TLS_MODES[row.original.tls].label}</Badge>,
    }),
    helper.accessor("enabled", {
      header: "On",
      cell: ({ row }) => <HostSwitch row={row.original} />,
    }),
    helper.display({
      id: "actions",
      enableHiding: false,
      cell: ({ row }) => (
        <div className="flex justify-end gap-1">
          {mode === "external" ? <SnippetsDialog row={row.original} /> : null}
          <FormDialog
            trigger={
              <Button variant="ghost" size="icon" className="size-8 text-muted-foreground" aria-label={`Edit ${row.original.domains[0]}`}>
                <PencilIcon />
              </Button>
            }
            title={`Edit ${row.original.domains[0]}`}
            submitLabel="Save"
            action={saveHost}
            className="sm:max-w-lg"
          >
            {(errors) => (
              <>
                <input type="hidden" name="id" value={row.original.id} />
                <HostFields errors={errors} containers={containers} initial={row.original} />
              </>
            )}
          </FormDialog>
          <ConfirmAction
            title={`Remove ${row.original.domains[0]}?`}
            description="The proxy stops serving these domains. The container isn't touched."
            confirmLabel="Remove"
            onConfirm={() => deleteHost(row.original.id)}
          >
            <Button variant="ghost" size="icon" className="size-8 text-muted-foreground" aria-label={`Remove ${row.original.domains[0]}`}>
              <Trash2Icon />
            </Button>
          </ConfirmAction>
        </div>
      ),
    }),
  ])
}

export function ProxyHostsTable({
  data,
  mode,
  containers,
}: {
  data: ProxyHostRow[]
  mode: ProxyMode
  containers: ContainerOption[]
}) {
  const columns = React.useMemo(() => buildColumns(mode, containers), [mode, containers])
  return (
    <DataTable
      data={data}
      columns={columns}
      getRowId={(r) => String(r.id)}
      searchText={(r) => `${r.domains.join(" ")} ${r.target}`}
      searchPlaceholder="Search hosts…"
      emptyMessage="No proxy hosts yet."
      toolbar={
        <FormDialog
          trigger={
            <Button size="sm">
              <PlusIcon data-icon="inline-start" />
              <span className="hidden lg:inline">Add host</span>
            </Button>
          }
          title="Add proxy host"
          description="Point DNS for these domains at this Docker host first."
          submitLabel="Save"
          action={saveHost}
          className="sm:max-w-lg"
        >
          {(errors) => <HostFields errors={errors} containers={containers} />}
        </FormDialog>
      }
    />
  )
}

function HostSwitch({ row }: { row: ProxyHostRow }) {
  const [pending, run] = useRunAction()
  return (
    <Switch
      checked={row.enabled}
      disabled={pending}
      aria-label={`${row.domains[0]} enabled`}
      onCheckedChange={(on) => run(() => setHostEnabled(row.id, on))}
    />
  )
}

function HostFields({ errors, containers, initial }: { errors: Errors; containers: ContainerOption[]; initial?: ProxyHostRow }) {
  const uid = React.useId()
  const [target, setTarget] = React.useState(initial?.target ?? "")
  const ports = containers.find((c) => c.name === target)?.ports ?? []
  const [tls, setTls] = React.useState<TlsMode>(initial?.tls ?? "auto")

  return (
    <FieldGroup className="gap-4">
      <Field data-invalid={errors.domains ? true : undefined}>
        <FieldLabel htmlFor={`${uid}-domains`}>Domains</FieldLabel>
        <Textarea
          id={`${uid}-domains`}
          name="domains"
          defaultValue={initial?.domains.join("\n")}
          placeholder={"app.example.com\nwww.app.example.com"}
          rows={2}
          className="font-mono text-sm"
          spellCheck={false}
          autoCapitalize="off"
        />
        <FieldDescription>One per line (or comma-separated).</FieldDescription>
        <FieldError>{errors.domains?.[0]}</FieldError>
      </Field>
      <div className="grid grid-cols-[1fr_8rem] gap-3">
        <Field data-invalid={errors.target ? true : undefined}>
          <FieldLabel htmlFor={`${uid}-target`}>Container</FieldLabel>
          <Select name="target" value={target} onValueChange={setTarget}>
            <SelectTrigger id={`${uid}-target`} className="w-full">
              <SelectValue placeholder="Pick a container" />
            </SelectTrigger>
            <SelectContent>
              {containers.map((c) => (
                <SelectItem key={c.name} value={c.name}>
                  {c.name}
                  {c.state !== "running" ? <span className="text-muted-foreground"> ({c.state})</span> : null}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <FieldError>{errors.target?.[0]}</FieldError>
        </Field>
        <Field data-invalid={errors.port ? true : undefined}>
          <FieldLabel htmlFor={`${uid}-port`}>Port</FieldLabel>
          <Input
            id={`${uid}-port`}
            name="port"
            type="number"
            min={1}
            max={65535}
            defaultValue={initial?.port ?? ports[0] ?? ""}
            key={target}
            list={`${uid}-ports`}
          />
          <datalist id={`${uid}-ports`}>
            {ports.map((p) => (
              <option key={p} value={p} />
            ))}
          </datalist>
          <FieldError>{errors.port?.[0]}</FieldError>
        </Field>
      </div>
      <Field data-invalid={errors.tls ? true : undefined}>
        <FieldLabel htmlFor={`${uid}-tls`}>TLS</FieldLabel>
        <Select name="tls" value={tls} onValueChange={(v) => setTls(v as TlsMode)}>
          <SelectTrigger id={`${uid}-tls`} className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {TLS_MODE_KEYS.map((t) => (
              <SelectItem key={t} value={t}>
                {TLS_MODES[t].label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <FieldDescription>{TLS_MODES[tls].description}</FieldDescription>
        <FieldError>{errors.tls?.[0]}</FieldError>
      </Field>
      <Label className="font-normal">
        <Checkbox name="enabled" value="on" defaultChecked={initial?.enabled ?? true} />
        Enabled
      </Label>
    </FieldGroup>
  )
}

function SnippetsDialog({ row }: { row: ProxyHostRow }) {
  const blocks = [
    { title: "Traefik labels", text: row.snippets.traefik, hint: "Add to the target container (compose labels or recreate)." },
    { title: "Caddyfile", text: row.snippets.caddy },
    { title: "Nginx / Nginx Proxy Manager", text: row.snippets.nginx },
  ]
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button variant="ghost" size="icon" className="size-8 text-muted-foreground" aria-label={`Config for ${row.domains[0]}`}>
          <CodeIcon />
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Config for {row.domains[0]}</DialogTitle>
          <DialogDescription>Use the block for the proxy you run. The target is reachable by name on the proxy network.</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-4">
          {blocks.map((b) => (
            <div key={b.title} className="flex flex-col gap-1.5">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium">{b.title}</span>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() =>
                    navigator.clipboard.writeText(b.text).then(
                      () => toast.success(`${b.title} copied`),
                      () => toast.error("Couldn't copy")
                    )
                  }
                >
                  <CopyIcon data-icon="inline-start" />
                  Copy
                </Button>
              </div>
              <pre className="overflow-x-auto rounded-md border bg-muted/40 p-3 font-mono text-xs">{b.text}</pre>
              {b.hint ? <span className="text-xs text-muted-foreground">{b.hint}</span> : null}
            </div>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  )
}
