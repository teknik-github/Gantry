"use client"

import * as React from "react"
import { useActionState } from "react"
import { EyeIcon, EyeOffIcon, RocketIcon, WandSparklesIcon } from "lucide-react"
import { toast } from "sonner"

import { deployTemplate } from "@/app/(app)/templates/actions"
import { EnvironmentField } from "@/components/gantry/environment-scope"
import { Button } from "@/components/ui/button"
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel, FieldLegend, FieldSet } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { submitKeepingValues } from "@/components/gantry/use-action"
import type { ServicePort } from "@/lib/compose-ports"
import { TLS_MODE_KEYS, TLS_MODES, type ProxyMode, type TlsMode } from "@/lib/proxy"
import { generatePassword, type TemplateVariable } from "@/lib/templates"
import type { ActionState } from "@/lib/validation"

/**
 * Deploy form for a template: stack name, one field per variable and an
 * optional domain to serve one of its services through the proxy.
 * Submitted without React's form reset (the Radix selects would jump back);
 * submitted values come back in the state.
 */
export function TemplateDeployForm({
  templateKey,
  stackName,
  variables,
  exposable = [],
  proxyMode = "off",
}: {
  templateKey: string
  stackName: string
  variables: TemplateVariable[]
  /** Services and container ports the compose file publishes. */
  exposable?: ServicePort[]
  proxyMode?: ProxyMode
}) {
  const [state, formAction, pending] = useActionState<ActionState, FormData>(deployTemplate, {})
  React.useEffect(() => {
    if (state.error && !state.fieldErrors) toast.error(state.error)
  }, [state])
  const errs = state.fieldErrors ?? {}
  const values = state.values ?? {}
  // Unique ids: Next keeps recently visited pages (another template's form) hidden in the DOM.
  const nameId = React.useId()

  return (
    <form method="post" onSubmit={submitKeepingValues(formAction)} className="flex flex-col gap-6">
      <EnvironmentField />
      <input type="hidden" name="template" value={templateKey} />
      <FieldGroup>
        <Field data-invalid={errs.name ? true : undefined} className="max-w-sm">
          <FieldLabel htmlFor={nameId}>Stack name</FieldLabel>
          <Input
            id={nameId}
            name="name"
            defaultValue={values.name ?? stackName}
            autoComplete="off"
            spellCheck={false}
            required
            aria-invalid={errs.name ? true : undefined}
          />
          <FieldDescription>Compose project name. Lowercase letters, digits, - and _.</FieldDescription>
          <FieldError>{errs.name?.[0]}</FieldError>
        </Field>

        {variables.length ? (
          <FieldSet>
            <FieldLegend variant="label">Settings</FieldLegend>
            <FieldDescription>Written to the stack&apos;s .env; you can change them later on the stack page.</FieldDescription>
            <div className="grid gap-4 @3xl/main:grid-cols-2">
              {variables.map((v) => (
                <VariableField
                  key={v.name}
                  variable={v}
                  value={values[`var:${v.name}`]}
                  error={errs[`var:${v.name}`]?.[0]}
                />
              ))}
            </div>
          </FieldSet>
        ) : null}

        {exposable.length ? <ExposeFields options={exposable} proxyMode={proxyMode} values={values} errors={errs} /> : null}

        {state.error && state.fieldErrors ? <FieldError>{state.error}</FieldError> : null}

        <Field orientation="horizontal">
          <Button type="submit" disabled={pending}>
            <RocketIcon data-icon="inline-start" />
            {pending ? "Deploying…" : "Deploy"}
          </Button>
        </Field>
      </FieldGroup>
    </form>
  )
}

function VariableField({ variable: v, value, error }: { variable: TemplateVariable; value?: string; error?: string }) {
  const id = `${React.useId()}-${v.name}`
  const ref = React.useRef<HTMLInputElement>(null)
  const [visible, setVisible] = React.useState(false)
  const isPassword = v.type === "password"

  return (
    <Field data-invalid={error ? true : undefined}>
      <FieldLabel htmlFor={id}>
        {v.label ?? v.name}
        {v.label ? <code className="text-xs font-normal text-muted-foreground">{v.name}</code> : null}
      </FieldLabel>
      <div className="flex gap-2">
        <Input
          ref={ref}
          id={id}
          name={`var:${v.name}`}
          type={isPassword && !visible ? "password" : v.type === "port" ? "number" : "text"}
          min={v.type === "port" ? 1 : undefined}
          max={v.type === "port" ? 65535 : undefined}
          defaultValue={value ?? (isPassword ? "" : (v.default ?? ""))}
          placeholder={isPassword ? "Generated when empty" : v.default}
          autoComplete={isPassword ? "new-password" : "off"}
          spellCheck={false}
          required={v.required && !isPassword && v.default === undefined}
          aria-invalid={error ? true : undefined}
          className="font-mono text-sm"
        />
        {isPassword ? (
          <>
            <Button
              type="button"
              variant="outline"
              size="icon"
              aria-label={visible ? `Hide ${v.name}` : `Show ${v.name}`}
              onClick={() => setVisible((s) => !s)}
            >
              {visible ? <EyeOffIcon /> : <EyeIcon />}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="icon"
              aria-label={`Generate ${v.name}`}
              title="Generate a random password"
              onClick={() => {
                if (!ref.current) return
                ref.current.value = generatePassword((b) => crypto.getRandomValues(b))
                setVisible(true)
              }}
            >
              <WandSparklesIcon />
            </Button>
          </>
        ) : null}
      </div>
      {v.description ? <FieldDescription>{v.description}</FieldDescription> : null}
      <FieldError>{error}</FieldError>
    </Field>
  )
}

function ExposeFields({
  options,
  proxyMode,
  values,
  errors,
}: {
  options: ServicePort[]
  proxyMode: ProxyMode
  values: Record<string, string>
  errors: Record<string, string[] | undefined>
}) {
  const uid = React.useId()
  const [expose, setExpose] = React.useState(values.expose || `${options[0].service}:${options[0].port}`)
  const [tls, setTls] = React.useState<TlsMode>((values.tls as TlsMode) || "auto")
  return (
    <FieldSet>
      <FieldLegend variant="label">Domain (optional)</FieldLegend>
      <FieldDescription>
        {proxyMode === "off"
          ? "Saved as a proxy host; it's served once the proxy is turned on (Proxy page)."
          : "Creates a proxy host after the deploy. Point the domain's DNS at this Docker host."}
      </FieldDescription>
      <div className="grid gap-4 @3xl/main:grid-cols-3">
        <Field data-invalid={errors.domains ? true : undefined}>
          <FieldLabel htmlFor={`${uid}-domains`}>Domain</FieldLabel>
          <Input id={`${uid}-domains`} name="domains" defaultValue={values.domains ?? ""} placeholder="app.example.com" autoComplete="off" spellCheck={false} />
          <FieldError>{errors.domains?.[0]}</FieldError>
        </Field>
        <Field data-invalid={errors.expose ? true : undefined}>
          <FieldLabel htmlFor={`${uid}-expose`}>Service</FieldLabel>
          <Select name="expose" value={expose} onValueChange={setExpose}>
            <SelectTrigger id={`${uid}-expose`} className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {options.map((o) => (
                <SelectItem key={`${o.service}:${o.port}`} value={`${o.service}:${o.port}`}>
                  {o.service} : {o.port}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <FieldError>{errors.expose?.[0]}</FieldError>
        </Field>
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
          <FieldError>{errors.tls?.[0]}</FieldError>
        </Field>
      </div>
    </FieldSet>
  )
}
