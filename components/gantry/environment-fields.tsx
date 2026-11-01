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

// The connection fields of the Add/Edit environment dialogs: Docker over
// TCP (with mutual TLS) or a socket, a Kubernetes API server, or the name
// of an agent environment.

type Errors = Record<string, string[] | undefined>

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
  return (
    <Field data-invalid={error ? true : undefined}>
      <div className="flex items-center justify-between gap-2">
        <FieldLabel htmlFor={id}>{label}</FieldLabel>
        <Button type="button" variant="ghost" size="sm" className="h-7" onClick={() => fileRef.current?.click()}>
          <UploadIcon data-icon="inline-start" />
          Load file
        </Button>
        <input
          ref={fileRef}
          type="file"
          className="hidden"
          accept={accept}
          aria-label={`${label} file`}
          onChange={async (e) => {
            const file = e.target.files?.[0]
            e.target.value = ""
            if (!file) return
            if (file.size > maxBytes) {
              toast.error(`${file.name} is too large`)
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

  if (initial?.type === "agent") return <AgentEnvironmentFields errors={errors} initial={initial} />

  return (
    <>
      {initial ? <input type="hidden" name="id" value={initial.id} /> : null}
      <Field data-invalid={errors.name ? true : undefined}>
        <FieldLabel htmlFor={`${prefix}-name`}>Name</FieldLabel>
        <Input
          id={`${prefix}-name`}
          name="name"
          placeholder="production"
          defaultValue={initial?.name}
          required
          autoFocus
        />
        <FieldError>{errors.name?.[0]}</FieldError>
      </Field>
      <Field>
        <FieldLabel htmlFor={`${prefix}-type`}>Connection</FieldLabel>
        <Select name="type" value={type} onValueChange={setType} disabled={initial?.type === "kubernetes"}>
          <SelectTrigger id={`${prefix}-type`} className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {initial?.type !== "kubernetes" ? (
              <>
                <SelectItem value="tcp">TCP (Docker API over the network)</SelectItem>
                <SelectItem value="socket">Unix socket (mounted into Gantry)</SelectItem>
              </>
            ) : null}
            {/* Docker and Kubernetes environments can't be turned into each other. */}
            {!initial || initial.type === "kubernetes" ? (
              <SelectItem value="kubernetes">Kubernetes (API server)</SelectItem>
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
            <FieldLabel htmlFor={`${prefix}-url`}>{tcp ? "Host and port" : "Socket path"}</FieldLabel>
            <Input
              id={`${prefix}-url`}
              name="url"
              required
              defaultValue={initial?.url}
              className="font-mono text-xs"
              placeholder={tcp ? (useTls ? "10.0.0.5:2376" : "10.0.0.5:2375") : "/var/run/docker.sock"}
            />
            {tcp && !useTls ? (
              <FieldDescription>Unencrypted Docker API. Only use it over a private network or VPN.</FieldDescription>
            ) : null}
            <FieldError>{errors.url?.[0]}</FieldError>
          </Field>
          {tcp ? (
            <Field orientation="horizontal">
              <Switch id={`${prefix}-tls`} checked={useTls} onCheckedChange={setUseTls} />
              <FieldLabel htmlFor={`${prefix}-tls`}>Use TLS</FieldLabel>
              {useTls ? <input type="hidden" name="tls" value="on" /> : null}
            </Field>
          ) : null}
          {tcp && useTls && !replacing ? (
            <div className="flex items-center justify-between gap-3 rounded-lg border p-3 text-sm">
              <div className="flex items-center gap-2">
                <ShieldCheckIcon className="size-4 text-emerald-600" />
                <div className="grid gap-0.5">
                  <span className="font-medium">TLS configured</span>
                  <span className="text-xs text-muted-foreground">
                    Certificates are stored encrypted; the private key is never shown again.
                  </span>
                </div>
              </div>
              <Button type="button" variant="outline" size="sm" onClick={() => setReplacing(true)}>
                Replace
              </Button>
            </div>
          ) : null}
          {tcp && initial?.tls && !useTls ? (
            <FieldDescription>The stored TLS certificates will be removed when you save.</FieldDescription>
          ) : null}
          {showPem ? (
            <>
              <input type="hidden" name="tls_replace" value="on" />
              <FieldDescription>
                Mutual TLS as with <Mono>docker --tlsverify</Mono>: the daemon is verified against the CA and Gantry
                authenticates with the client certificate. Paste PEM text or load the files.
              </FieldDescription>
              <PemField
                id={`${prefix}-tls-ca`}
                name="tls_ca"
                label="CA certificate"
                placeholder="ca.pem: -----BEGIN CERTIFICATE-----"
                value={pem.ca}
                onChange={(ca) => setPem((p) => ({ ...p, ca }))}
                error={errors.tls_ca?.[0]}
              />
              <PemField
                id={`${prefix}-tls-cert`}
                name="tls_cert"
                label="Client certificate"
                placeholder="cert.pem: -----BEGIN CERTIFICATE-----"
                value={pem.cert}
                onChange={(cert) => setPem((p) => ({ ...p, cert }))}
                error={errors.tls_cert?.[0]}
              />
              <PemField
                id={`${prefix}-tls-key`}
                name="tls_key"
                label="Client key"
                placeholder="key.pem: -----BEGIN PRIVATE KEY-----"
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
  return (
    <>
      <input type="hidden" name="id" value={initial.id} />
      <input type="hidden" name="type" value="agent" />
      <Field data-invalid={errors.name ? true : undefined}>
        <FieldLabel htmlFor={`${uid}-name`}>Name</FieldLabel>
        <Input id={`${uid}-name`} name="name" defaultValue={initial.name} required autoFocus />
        <FieldError>{errors.name?.[0]}</FieldError>
      </Field>
      <FieldDescription>
        The connection comes from the agent on the host. Use &ldquo;Rotate agent key&rdquo; to issue a new key.
      </FieldDescription>
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

  const namespaceField = (
    <Field data-invalid={errors.kube_namespace ? true : undefined}>
      <FieldLabel htmlFor={`${uid}-ns`}>Default namespace</FieldLabel>
      <Input
        id={`${uid}-ns`}
        name="kube_namespace"
        placeholder={mode === "kubeconfig" && replacing ? "from the context" : "all namespaces"}
        defaultValue={editing && !replacing ? (initial?.kubeNamespace ?? "") : ""}
        className="font-mono text-xs"
        autoComplete="off"
        spellCheck={false}
      />
      <FieldDescription>Preselected on the list pages and for Apply. Leave empty to show all namespaces.</FieldDescription>
      <FieldError>{errors.kube_namespace?.[0]}</FieldError>
    </Field>
  )

  if (!replacing) {
    return (
      <>
        <div className="flex items-center justify-between gap-3 rounded-lg border p-3 text-sm">
          <div className="flex min-w-0 items-center gap-2">
            <ShipWheelIcon className="size-4 shrink-0 text-emerald-600" />
            <div className="grid min-w-0 gap-0.5">
              <span className="truncate font-mono text-xs">{initial?.url}</span>
              <span className="text-xs text-muted-foreground">
                Connected with {initial?.kubeAuth.filter((a) => a !== "CA").join(" and ") || "stored credentials"}
                {initial?.kubeInsecure ? ", TLS verification off" : ""}. Credentials are stored encrypted and never shown
                again.
              </span>
            </div>
          </div>
          <Button type="button" variant="outline" size="sm" onClick={() => setReplacing(true)}>
            Replace
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
        <FieldLabel>Credentials</FieldLabel>
        <ToggleGroup
          type="single"
          variant="outline"
          size="sm"
          value={mode}
          onValueChange={(v) => v && setMode(v as "token" | "kubeconfig")}
          aria-label="Credentials"
        >
          <ToggleGroupItem value="token">Service account token</ToggleGroupItem>
          <ToggleGroupItem value="kubeconfig">Kubeconfig</ToggleGroupItem>
        </ToggleGroup>
      </Field>
      {/* Keyed so inputs aren't reused across modes (the token would end up in Context). */}
      {mode === "token" ? (
        <React.Fragment key="token">
          <Field data-invalid={errors.kube_server ? true : undefined}>
            <FieldLabel htmlFor={`${uid}-server`}>API server URL</FieldLabel>
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
            <FieldLabel htmlFor={`${uid}-token`}>Bearer token</FieldLabel>
            <Input
              id={`${uid}-token`}
              name="kube_token"
              type="password"
              required
              autoComplete="off"
              className="font-mono text-xs"
            />
            <FieldDescription>
              A service account token, e.g. from <Mono>kubectl create token gantry -n kube-system</Mono>. Gantry can do
              what the account&apos;s RBAC allows.
            </FieldDescription>
            <FieldError>{errors.kube_token?.[0]}</FieldError>
          </Field>
          <PemField
            id={`${uid}-ca`}
            name="kube_ca"
            label="CA certificate"
            placeholder="Cluster CA: -----BEGIN CERTIFICATE----- (optional)"
            value={ca}
            onChange={setCa}
            required={false}
            error={errors.kube_ca?.[0]}
            description="Leave empty if the API server's certificate is signed by a public CA."
          />
          <Field orientation="horizontal">
            <Switch id={`${uid}-insecure`} checked={insecure} onCheckedChange={setInsecure} />
            <FieldLabel htmlFor={`${uid}-insecure`}>Skip TLS verification</FieldLabel>
            {insecure ? <input type="hidden" name="kube_insecure" value="on" /> : null}
          </Field>
          {insecure ? (
            <p className="flex items-start gap-2 rounded-lg border border-amber-500/40 p-3 text-xs text-amber-700 dark:text-amber-400">
              <ShieldAlertIcon className="mt-0.5 size-4 shrink-0" />
              The API server&apos;s certificate won&apos;t be checked, so anyone on the network path could impersonate
              the cluster and capture the token. Only use this for test clusters.
            </p>
          ) : null}
        </React.Fragment>
      ) : (
        <React.Fragment key="kubeconfig">
          <PemField
            id={`${uid}-kubeconfig`}
            name="kubeconfig"
            label="Kubeconfig"
            placeholder="apiVersion: v1&#10;kind: Config&#10;clusters: ..."
            value={kubeconfig}
            onChange={setKubeconfig}
            accept=".yaml,.yml,.conf,.config,text/plain,application/yaml"
            maxBytes={KUBECONFIG_MAX_BYTES}
            error={errors.kubeconfig?.[0]}
            description={
              <>
                Certificates must be embedded (<Mono>kubectl config view --raw --minify --flatten</Mono>). Token and
                client certificate users work; exec and auth-provider plugins don&apos;t.
              </>
            }
          />
          <Field data-invalid={errors.kube_context ? true : undefined}>
            <FieldLabel htmlFor={`${uid}-context`}>Context</FieldLabel>
            <Input
              id={`${uid}-context`}
              name="kube_context"
              placeholder="current-context"
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
