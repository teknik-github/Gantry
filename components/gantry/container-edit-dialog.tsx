"use client"

import { useRouter } from "next/navigation"
import { CloudDownloadIcon, PencilIcon, TriangleAlertIcon } from "lucide-react"

import { editContainer, pullAndRecreateContainer } from "@/app/(app)/containers/recreate-actions"
import { ConfirmAction } from "@/components/gantry/confirm-button"
import { useEnvironmentId } from "@/components/gantry/environment-scope"
import { FormDialog } from "@/components/gantry/form-dialog"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Textarea } from "@/components/ui/textarea"
import type { EditFormValues } from "@/lib/container-form"
import { useI18n } from "@/lib/i18n/client"

export type RecreateInfo = {
  values: EditFormValues
  /** Networks that can be attached (existing bridge/overlay/… networks). */
  availableNetworks: string[]
  networksEditable: boolean
  networkMode: string
  composeProject: string | null
  /** Reason recreating is impossible (Gantry's own container, --rm, …). */
  blocker: string | null
  entrypoint: string
  /** Mounts the form can't edit; they are kept. */
  fixedMounts: string[]
}

export function ComposeWarning({ project }: { project: string }) {
  const i18n = useI18n()
  return (
    <div className="flex gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-900 dark:text-amber-200">
      <TriangleAlertIcon className="mt-0.5 size-4 shrink-0" />
      <p>
        {i18n.rich(i18n.t.containers.edit.composeWarning, {
          project: <strong>{project}</strong>,
          command: <code>docker compose up</code>,
        })}
      </p>
    </div>
  )
}

export function EditContainerDialog({ id, name, info }: { id: string; name: string; info: RecreateInfo }) {
  const router = useRouter()
  const i18n = useI18n()
  const { t } = i18n
  const text = t.containers.form
  const v = info.values
  const networks = [...new Set([...info.availableNetworks, ...v.networks])].sort()

  const trigger = (
    <Button size="sm" variant="outline" disabled={Boolean(info.blocker)} title={info.blocker ?? undefined}>
      <PencilIcon data-icon="inline-start" />
      {t.common.actions.edit}
    </Button>
  )

  return (
    <FormDialog
      trigger={trigger}
      title={i18n.format(t.containers.edit.title, { name })}
      description={t.containers.edit.description}
      submitLabel={t.containers.edit.submit}
      className="sm:max-w-2xl"
      action={async (prev, fd) => {
        const res = await editContainer(prev, fd)
        if (res.ok && res.containerId && res.containerId !== id) router.replace(`/containers/${res.containerId}`)
        return res
      }}
    >
      {(errors) => (
        <FieldGroup className="max-h-[60vh] gap-4 overflow-y-auto pr-1">
          <input type="hidden" name="id" value={id} />
          {info.composeProject ? <ComposeWarning project={info.composeProject} /> : null}
          <div className="grid gap-4 sm:grid-cols-2">
            <Field data-invalid={errors.image ? true : undefined}>
              <FieldLabel htmlFor="e-image">{t.common.fields.image}</FieldLabel>
              <Input id="e-image" name="image" defaultValue={v.image} required className="font-mono text-xs" />
              <FieldError>{errors.image?.[0]}</FieldError>
            </Field>
            <Field data-invalid={errors.name ? true : undefined}>
              <FieldLabel htmlFor="e-name">{t.common.fields.name}</FieldLabel>
              <Input id="e-name" name="name" defaultValue={v.name} required />
              <FieldError>{errors.name?.[0]}</FieldError>
            </Field>
          </div>
          <Field>
            <FieldLabel htmlFor="e-command">{text.command}</FieldLabel>
            <Input
              id="e-command"
              name="command"
              defaultValue={v.command}
              placeholder={text.commandPlaceholder}
              className="font-mono text-xs"
            />
            {info.entrypoint ? (
              <FieldDescription>
                {i18n.rich(text.entrypointKept, { entrypoint: <code>{info.entrypoint}</code> })}
              </FieldDescription>
            ) : null}
          </Field>
          <Field data-invalid={errors.env ? true : undefined}>
            <FieldLabel htmlFor="e-env">{text.envVars}</FieldLabel>
            <Textarea id="e-env" name="env" defaultValue={v.env} rows={5} className="font-mono text-xs" />
            <FieldDescription>{text.envHelp}</FieldDescription>
            <FieldError>{errors.env?.[0]}</FieldError>
          </Field>
          <Field data-invalid={errors.ports ? true : undefined}>
            <FieldLabel htmlFor="e-ports">{text.portMappings}</FieldLabel>
            <Textarea
              id="e-ports"
              name="ports"
              defaultValue={v.ports}
              rows={2}
              placeholder={"8080:80\n127.0.0.1:5432:5432"}
              className="font-mono text-xs"
            />
            <FieldDescription>{text.portsHelpEdit}</FieldDescription>
            <FieldError>{errors.ports?.[0]}</FieldError>
          </Field>
          <Field data-invalid={errors.volumes ? true : undefined}>
            <FieldLabel htmlFor="e-volumes">{text.volumes}</FieldLabel>
            <Textarea
              id="e-volumes"
              name="volumes"
              defaultValue={v.volumes}
              rows={3}
              placeholder={"app-data:/data\n/srv/config:/etc/app:ro"}
              className="font-mono text-xs"
            />
            <FieldDescription>
              {text.volumesHelpEdit}
              {info.fixedMounts.length ? ` ${i18n.format(text.alsoKept, { mounts: info.fixedMounts.join(", ") })}` : null}
            </FieldDescription>
            <FieldError>{errors.volumes?.[0]}</FieldError>
          </Field>
          <Field>
            <FieldLabel htmlFor="e-restart">{text.restartPolicy}</FieldLabel>
            <Select name="restart" defaultValue={v.restart}>
              <SelectTrigger id="e-restart" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="no">{text.restartPolicies.no}</SelectItem>
                <SelectItem value="always">{text.restartPolicies.always}</SelectItem>
                <SelectItem value="unless-stopped">{text.restartPolicies["unless-stopped"]}</SelectItem>
                <SelectItem value="on-failure">{text.restartPolicies["on-failure"]}</SelectItem>
              </SelectContent>
            </Select>
          </Field>
          {info.networksEditable ? (
            <FieldSet data-invalid={errors.networks ? true : undefined}>
              <FieldLegend variant="label">{text.networks}</FieldLegend>
              <input type="hidden" name="networksShown" value="1" />
              <div className="grid gap-2 sm:grid-cols-2">
                {networks.map((n) => (
                  <Label key={n} className="font-normal">
                    <Checkbox name="networks" value={n} defaultChecked={v.networks.includes(n)} />
                    {n}
                  </Label>
                ))}
              </div>
              <FieldDescription>{text.networksHelp}</FieldDescription>
              <FieldError>{errors.networks?.[0]}</FieldError>
            </FieldSet>
          ) : (
            <p className="text-sm text-muted-foreground">
              {i18n.rich(text.networkModeKept, { mode: <code>{info.networkMode}</code> })}
            </p>
          )}
          <Label className="font-normal">
            <Checkbox name="pull" value="on" />
            {text.pullBeforeRecreate}
          </Label>
        </FieldGroup>
      )}
    </FormDialog>
  )
}

export function PullRecreateConfirm({
  id,
  name,
  image,
  composeProject,
  open,
  onOpenChange,
  onDone,
  children,
}: {
  id: string
  name: string
  image: string
  composeProject: string | null
  open?: boolean
  onOpenChange?: (open: boolean) => void
  /** Called with the replacement's id after a successful recreate. */
  onDone?: (newId: string) => void
  children?: React.ReactNode
}) {
  const environmentId = useEnvironmentId()
  const i18n = useI18n()
  const { t } = i18n
  return (
    <ConfirmAction
      open={open}
      onOpenChange={onOpenChange}
      title={i18n.format(t.containers.edit.pullRecreateTitle, { name })}
      description={<>{i18n.rich(t.containers.edit.pullRecreateDescription, { image: <code>{image}</code> })}</>}
      extra={composeProject ? <ComposeWarning project={composeProject} /> : undefined}
      confirmLabel={t.containers.actions.pullRecreate}
      destructive={false}
      onConfirm={async () => {
        const res = await pullAndRecreateContainer(id, environmentId)
        if (res.ok && res.containerId && res.containerId !== id) onDone?.(res.containerId)
        return res
      }}
    >
      {children}
    </ConfirmAction>
  )
}

export function PullRecreateButton({
  id,
  name,
  image,
  info,
}: {
  id: string
  name: string
  image: string
  info: RecreateInfo
}) {
  const router = useRouter()
  const { t } = useI18n()
  return (
    <PullRecreateConfirm
      id={id}
      name={name}
      image={image}
      composeProject={info.composeProject}
      onDone={(newId) => router.replace(`/containers/${newId}`)}
    >
      <Button size="sm" variant="outline" disabled={Boolean(info.blocker)} title={info.blocker ?? undefined}>
        <CloudDownloadIcon data-icon="inline-start" />
        {t.containers.actions.pullRecreate}
      </Button>
    </PullRecreateConfirm>
  )
}
