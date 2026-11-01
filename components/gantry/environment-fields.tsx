"use client"

import * as React from "react"
import { toast } from "sonner"
import { ShieldAlertIcon, ShieldCheckIcon, ShipWheelIcon, UploadIcon } from "lucide-react"

import type { EnvironmentRow } from "@/components/gantry/environments-table"
import { Mono } from "@/components/gantry/ui"
import { Button } from "@/components/ui/button"
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import type { I18n } from "@/lib/i18n"
import { useI18n } from "@/lib/i18n/client"

// The connection fields of the Add/Edit environment dialogs: Docker over
// TCP (with mutual TLS) or a socket, a Kubernetes API server, or the name
// of an agent environment.

type Errors = Record<string, string[] | undefined>

/** Kinds of stored Kubernetes credentials (credentialSummary), in the user's language. */
export function credentialKind(kind: string, t: I18n["t"]) {
  const kinds = t.environments.kubernetes.kinds
  return kind === "token" ? kinds.token : kind === "client certificate" ? kinds.clientCertificate : kind
}

const PEM_MAX_BYTES = 64 * 1024

function PemField({
  id,
  name,
  label,
  placeholder,
  value,
  onChange,
  error,
  required = true,
  accept = ".pem,.crt,.cer,.key,text/plain",
  maxBytes = PEM_MAX_BYTES,
  description,
}: {
  id: string
  name: string
  label: string
  placeholder: string
  value: string
  onChange: (value: string) => void
  error?: string
  required?: boolean
  accept?: string
  maxBytes?: number
  description?: React.ReactNode
}) {
  const fileRef = React.useRef<HTMLInputElement>(null)
  const { t, format } = useI18n()
  return (
    <Field data-invalid={error ? true : undefined}>
      <div className="flex items-center justify-between gap-2">
        <FieldLabel htmlFor={id}>{label}</FieldLabel>
        <Button type="button" variant="ghost" size="sm" className="h-7" onClick={() => fileRef.current?.click()}>
          <UploadIcon data-icon="inline-start" />
          {t.environments.form.loadFile}
        </Button>
        <input
          ref={fileRef}
          type="file"
          className="hidden"
          accept={accept}
          aria-label={format(t.environments.form.fileLabel, { label })}
          onChange={async (e) => {
            const file = e.target.files?.[0]
            e.target.value = ""
            if (!file) return
            if (file.size > maxBytes) {
              toast.error(format(t.environments.form.fileTooLarge, { name: file.name }))
              return
            }
            onChange(await file.text())
          }}
        />
      </div>
      <Textarea
        id={id}
        name={name}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        required={required}
        spellCheck={false}
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="off"
        className="h-20 max-h-32 resize-none font-mono text-[11px] leading-tight [field-sizing:fixed]"
      />
      {description ? <FieldDescription>{description}</FieldDescription> : null}
      <FieldError>{error}</FieldError>
    </Field>
  )
}

export type EnvironmentDefaults = Pick<EnvironmentRow, "id" | "name" | "type" | "url" | "tls" | "kubeAuth" | "kubeInsecure" | "kubeNamespace">

/** Fields shared by the add and edit dialogs. */
export function EnvironmentFields({ errors, initial }: { errors: Errors; initial?: EnvironmentDefaults }) {
  const prefix = initial ? `e${initial.id}` : "e"
  const [type, setType] = React.useState<string>(initial?.type ?? "tcp")
  const [useTls, setUseTls] = React.useState(initial?.tls ?? false)
  // Editing an environment that already has certificates keeps them unless replaced.
  const [replacing, setReplacing] = React.useState(!initial?.tls)
  const [pem, setPem] = React.useState({ ca: "", cert: "", key: "" })
  const tcp = type === "tcp"
  const kubernetes = type === "kubernetes"
  const showPem = tcp && useTls && replacing
  const i18n = useI18n()
  const text = i18n.t.environments.form

  if (initial?.type === "agent") return <AgentEnvironmentFields errors={errors} initial={initial} />

  return (
    <>
      {initial ? <input type="hidden" name="id" value={initial.id} /> : null}
      <Field data-invalid={errors.name ? true : undefined}>
        <FieldLabel htmlFor={`${prefix}-name`}>{i18n.t.common.fields.name}</FieldLabel>
        <Input
          id={`${prefix}-name`}
          name="name"
          placeholder={text.namePlaceholder}
          defaultValue={initial?.name}
          required
          autoFocus
        />
        <FieldError>{errors.name?.[0]}</FieldError>
      </Field>
      <Field>
        <FieldLabel htmlFor={`${prefix}-type`}>{text.connection}</FieldLabel>
        <Select name="type" value={type} onValueChange={setType} disabled={initial?.type === "kubernetes"}>
          <SelectTrigger id={`${prefix}-type`} className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {initial?.type !== "kubernetes" ? (
              <>
                <SelectItem value="tcp">{text.typeTcp}</SelectItem>
                <SelectItem value="socket">{text.typeSocket}</SelectItem>
              </>
            ) : null}
            {/* Docker and Kubernetes environments can't be turned into each other. */}
            {!initial || initial.type === "kubernetes" ? (
              <SelectItem value="kubernetes">{text.typeKubernetes}</SelectItem>
            ) : null}
          </SelectContent>
        </Select>
        {/* A disabled select submits nothing. */}
        {initial?.type === "kubernetes" ? <input type="hidden" name="type" value="kubernetes" /> : null}
      </Field>
      {kubernetes ? (
        <KubernetesFields errors={errors} initial={initial} />
      ) : (
        <>
          <Field data-invalid={errors.url ? true : undefined}>
            <FieldLabel htmlFor={`${prefix}-url`}>{tcp ? text.hostAndPort : text.socketPath}</FieldLabel>
            <Input
              id={`${prefix}-url`}
              name="url"
              required
              defaultValue={initial?.url}
              className="font-mono text-xs"
              placeholder={tcp ? (useTls ? "10.0.0.5:2376" : "10.0.0.5:2375") : "/var/run/docker.sock"}
            />
            {tcp && !useTls ? (
              <FieldDescription>{text.unencrypted}</FieldDescription>
            ) : null}
            <FieldError>{errors.url?.[0]}</FieldError>
          </Field>
          {tcp ? (
            <Field orientation="horizontal">
              <Switch id={`${prefix}-tls`} checked={useTls} onCheckedChange={setUseTls} />
              <FieldLabel htmlFor={`${prefix}-tls`}>{text.useTls}</FieldLabel>
              {useTls ? <input type="hidden" name="tls" value="on" /> : null}
            </Field>
          ) : null}
          {tcp && useTls && !replacing ? (
            <div className="flex items-center justify-between gap-3 rounded-lg border p-3 text-sm">
              <div className="flex items-center gap-2">
                <ShieldCheckIcon className="size-4 text-emerald-600" />
                <div className="grid gap-0.5">
                  <span className="font-medium">{text.tlsConfigured}</span>
                  <span className="text-xs text-muted-foreground">{text.tlsStored}</span>
                </div>
              </div>
              <Button type="button" variant="outline" size="sm" onClick={() => setReplacing(true)}>
                {text.replace}
              </Button>
            </div>
          ) : null}
          {tcp && initial?.tls && !useTls ? (
            <FieldDescription>{text.tlsRemoved}</FieldDescription>
          ) : null}
          {showPem ? (
            <>
              <input type="hidden" name="tls_replace" value="on" />
              <FieldDescription>{i18n.rich(text.tlsHelp, { command: <Mono>docker --tlsverify</Mono> })}</FieldDescription>
              <PemField
                id={`${prefix}-tls-ca`}
                name="tls_ca"
                label={text.caCertificate}
                placeholder={text.caPlaceholder}
                value={pem.ca}
                onChange={(ca) => setPem((p) => ({ ...p, ca }))}
                error={errors.tls_ca?.[0]}
              />
              <PemField
                id={`${prefix}-tls-cert`}
                name="tls_cert"
                label={text.clientCertificate}
                placeholder={text.certPlaceholder}
                value={pem.cert}
                onChange={(cert) => setPem((p) => ({ ...p, cert }))}
                error={errors.tls_cert?.[0]}
              />
              <PemField
                id={`${prefix}-tls-key`}
                name="tls_key"
                label={text.clientKey}
                placeholder={text.keyPlaceholder}
                value={pem.key}
                onChange={(key) => setPem((p) => ({ ...p, key }))}
                error={errors.tls_key?.[0]}
              />
            </>
          ) : null}
        </>
      )}
    </>
  )
}

/** Agent environments: only the name is edited here; the key is rotated from the row. */
function AgentEnvironmentFields({ errors, initial }: { errors: Errors; initial: EnvironmentDefaults }) {
  const uid = React.useId()
  const { t } = useI18n()
  return (
    <>
      <input type="hidden" name="id" value={initial.id} />
      <input type="hidden" name="type" value="agent" />
      <Field data-invalid={errors.name ? true : undefined}>
        <FieldLabel htmlFor={`${uid}-name`}>{t.common.fields.name}</FieldLabel>
        <Input id={`${uid}-name`} name="name" defaultValue={initial.name} required autoFocus />
        <FieldError>{errors.name?.[0]}</FieldError>
      </Field>
      <FieldDescription>{t.environments.form.agentHelp}</FieldDescription>
    </>
  )
}

const KUBECONFIG_MAX_BYTES = 256 * 1024

/**
 * Kubernetes connection: API server + service account token (+ CA), or a
 * pasted kubeconfig. When editing, the stored connection is kept unless
 * replaced; the token and keys are never sent back to the browser.
 */
function KubernetesFields({ errors, initial }: { errors: Errors; initial?: EnvironmentDefaults }) {
  // Unique ids: Next keeps recently visited pages hidden in the DOM.
  const uid = React.useId()
  const editing = initial?.type === "kubernetes"
  const [replacing, setReplacing] = React.useState(!editing)
  const [mode, setMode] = React.useState<"token" | "kubeconfig">("token")
  const [insecure, setInsecure] = React.useState(false)
  const [ca, setCa] = React.useState("")
  const [kubeconfig, setKubeconfig] = React.useState("")
  const i18n = useI18n()
  const { t, format } = i18n
  const text = t.environments.kubernetes

  const namespaceField = (
    <Field data-invalid={errors.kube_namespace ? true : undefined}>
      <FieldLabel htmlFor={`${uid}-ns`}>{text.defaultNamespace}</FieldLabel>
      <Input
        id={`${uid}-ns`}
        name="kube_namespace"
        placeholder={mode === "kubeconfig" && replacing ? text.namespaceFromContext : text.allNamespaces}
        defaultValue={editing && !replacing ? (initial?.kubeNamespace ?? "") : ""}
        className="font-mono text-xs"
        autoComplete="off"
        spellCheck={false}
      />
      <FieldDescription>{text.namespaceHelp}</FieldDescription>
      <FieldError>{errors.kube_namespace?.[0]}</FieldError>
    </Field>
  )

  if (!replacing) {
    const kinds = (initial?.kubeAuth ?? []).filter((a) => a !== "CA").map((a) => credentialKind(a, t))
    const credentials =
      kinds.length === 2 ? format(text.and, { first: kinds[0], second: kinds[1] }) : kinds.join(", ") || text.storedCredentials
    return (
      <>
        <div className="flex items-center justify-between gap-3 rounded-lg border p-3 text-sm">
          <div className="flex min-w-0 items-center gap-2">
            <ShipWheelIcon className="size-4 shrink-0 text-emerald-600" />
            <div className="grid min-w-0 gap-0.5">
              <span className="truncate font-mono text-xs">{initial?.url}</span>
              <span className="text-xs text-muted-foreground">
                {format(initial?.kubeInsecure ? text.connectedWithInsecure : text.connectedWith, { credentials })}
              </span>
            </div>
          </div>
          <Button type="button" variant="outline" size="sm" onClick={() => setReplacing(true)}>
            {t.environments.form.replace}
          </Button>
        </div>
        {namespaceField}
      </>
    )
  }

  return (
    <>
      {editing ? <input type="hidden" name="kube_replace" value="on" /> : null}
      <input type="hidden" name="kube_mode" value={mode} />
      <Field>
        <FieldLabel>{text.credentials}</FieldLabel>
        <ToggleGroup
          type="single"
          variant="outline"
          size="sm"
          value={mode}
          onValueChange={(v) => v && setMode(v as "token" | "kubeconfig")}
          aria-label={text.credentials}
        >
          <ToggleGroupItem value="token">{text.serviceAccountToken}</ToggleGroupItem>
          <ToggleGroupItem value="kubeconfig">{text.kubeconfig}</ToggleGroupItem>
        </ToggleGroup>
      </Field>
      {/* Keyed so inputs aren't reused across modes (the token would end up in Context). */}
      {mode === "token" ? (
        <React.Fragment key="token">
          <Field data-invalid={errors.kube_server ? true : undefined}>
            <FieldLabel htmlFor={`${uid}-server`}>{text.apiServer}</FieldLabel>
            <Input
              id={`${uid}-server`}
              name="kube_server"
              required
              placeholder="https://10.0.0.5:6443"
              className="font-mono text-xs"
              autoComplete="off"
              spellCheck={false}
            />
            <FieldError>{errors.kube_server?.[0]}</FieldError>
          </Field>
          <Field data-invalid={errors.kube_token ? true : undefined}>
            <FieldLabel htmlFor={`${uid}-token`}>{text.bearerToken}</FieldLabel>
            <Input
              id={`${uid}-token`}
              name="kube_token"
              type="password"
              required
              autoComplete="off"
              className="font-mono text-xs"
            />
            <FieldDescription>
              {i18n.rich(text.tokenHelp, { command: <Mono>kubectl create token gantry -n kube-system</Mono> })}
            </FieldDescription>
            <FieldError>{errors.kube_token?.[0]}</FieldError>
          </Field>
          <PemField
            id={`${uid}-ca`}
            name="kube_ca"
            label={t.environments.form.caCertificate}
            placeholder={text.caPlaceholder}
            value={ca}
            onChange={setCa}
            required={false}
            error={errors.kube_ca?.[0]}
            description={text.caHelp}
          />
          <Field orientation="horizontal">
            <Switch id={`${uid}-insecure`} checked={insecure} onCheckedChange={setInsecure} />
            <FieldLabel htmlFor={`${uid}-insecure`}>{text.skipTlsVerify}</FieldLabel>
            {insecure ? <input type="hidden" name="kube_insecure" value="on" /> : null}
          </Field>
          {insecure ? (
            <p className="flex items-start gap-2 rounded-lg border border-amber-500/40 p-3 text-xs text-amber-700 dark:text-amber-400">
              <ShieldAlertIcon className="mt-0.5 size-4 shrink-0" />
              {text.insecureWarning}
            </p>
          ) : null}
        </React.Fragment>
      ) : (
        <React.Fragment key="kubeconfig">
          <PemField
            id={`${uid}-kubeconfig`}
            name="kubeconfig"
            label={text.kubeconfig}
            placeholder="apiVersion: v1&#10;kind: Config&#10;clusters: ..."
            value={kubeconfig}
            onChange={setKubeconfig}
            accept=".yaml,.yml,.conf,.config,text/plain,application/yaml"
            maxBytes={KUBECONFIG_MAX_BYTES}
            error={errors.kubeconfig?.[0]}
            description={i18n.rich(text.kubeconfigHelp, { command: <Mono>kubectl config view --raw --minify --flatten</Mono> })}
          />
          <Field data-invalid={errors.kube_context ? true : undefined}>
            <FieldLabel htmlFor={`${uid}-context`}>{text.context}</FieldLabel>
            <Input
              id={`${uid}-context`}
              name="kube_context"
              placeholder={text.contextPlaceholder}
              className="font-mono text-xs"
              autoComplete="off"
              spellCheck={false}
            />
            <FieldError>{errors.kube_context?.[0]}</FieldError>
          </Field>
        </React.Fragment>
      )}
      {namespaceField}
    </>
  )
}
