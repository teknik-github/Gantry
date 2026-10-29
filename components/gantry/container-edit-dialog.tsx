"use client"

import { useRouter } from "next/navigation"
import { CloudDownloadIcon, PencilIcon, TriangleAlertIcon } from "lucide-react"

import { editContainer, pullAndRecreateContainer } from "@/app/(app)/containers/recreate-actions"
import { ConfirmAction } from "@/components/gantry/confirm-button"
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
  return (
    <div className="flex gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-900 dark:text-amber-200">
      <TriangleAlertIcon className="mt-0.5 size-4 shrink-0" />
      <p>
        This container belongs to the compose project <strong>{project}</strong>. Changes made here are overwritten
        the next time the project is redeployed with <code>docker compose up</code>.
      </p>
    </div>
  )
}

export function EditContainerDialog({ id, name, info }: { id: string; name: string; info: RecreateInfo }) {
  const router = useRouter()
  const v = info.values
  const networks = [...new Set([...info.availableNetworks, ...v.networks])].sort()

  const trigger = (
    <Button size="sm" variant="outline" disabled={Boolean(info.blocker)} title={info.blocker ?? undefined}>
      <PencilIcon data-icon="inline-start" />
      Edit
    </Button>
  )

  return (
    <FormDialog
      trigger={trigger}
      title={`Edit ${name}`}
      description="Docker can't change these settings in place, so the container is recreated: stopped, replaced and started again. Everything not shown here (labels, health check, user, capabilities, resources, logging…) is kept. If a step fails, the original container is restored."
      submitLabel="Recreate"
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
              <FieldLabel htmlFor="e-image">Image</FieldLabel>
              <Input id="e-image" name="image" defaultValue={v.image} required className="font-mono text-xs" />
              <FieldError>{errors.image?.[0]}</FieldError>
            </Field>
            <Field data-invalid={errors.name ? true : undefined}>
              <FieldLabel htmlFor="e-name">Name</FieldLabel>
              <Input id="e-name" name="name" defaultValue={v.name} required />
              <FieldError>{errors.name?.[0]}</FieldError>
            </Field>
          </div>
          <Field>
            <FieldLabel htmlFor="e-command">Command</FieldLabel>
            <Input
              id="e-command"
              name="command"
              defaultValue={v.command}
              placeholder="(image default)"
              className="font-mono text-xs"
            />
            {info.entrypoint ? (
              <FieldDescription>
                Entrypoint (kept): <code>{info.entrypoint}</code>
              </FieldDescription>
            ) : null}
          </Field>
          <Field data-invalid={errors.env ? true : undefined}>
            <FieldLabel htmlFor="e-env">Environment variables</FieldLabel>
            <Textarea id="e-env" name="env" defaultValue={v.env} rows={5} className="font-mono text-xs" />
            <FieldDescription>One KEY=value per line. Variables set by the image come back even if removed.</FieldDescription>
            <FieldError>{errors.env?.[0]}</FieldError>
          </Field>
          <Field data-invalid={errors.ports ? true : undefined}>
            <FieldLabel htmlFor="e-ports">Port mappings</FieldLabel>
            <Textarea
              id="e-ports"
              name="ports"
              defaultValue={v.ports}
              rows={2}
              placeholder={"8080:80\n127.0.0.1:5432:5432"}
              className="font-mono text-xs"
            />
            <FieldDescription>One per line: [ip:]host:container[/tcp|udp]</FieldDescription>
            <FieldError>{errors.ports?.[0]}</FieldError>
          </Field>
          <Field data-invalid={errors.volumes ? true : undefined}>
            <FieldLabel htmlFor="e-volumes">Volumes</FieldLabel>
            <Textarea
              id="e-volumes"
              name="volumes"
              defaultValue={v.volumes}
              rows={3}
              placeholder={"app-data:/data\n/srv/config:/etc/app:ro"}
              className="font-mono text-xs"
            />
            <FieldDescription>
              One per line: volume-or-host-path:/container/path[:ro]. Anonymous volumes are listed by id so their data is
              kept.
              {info.fixedMounts.length ? ` Also kept: ${info.fixedMounts.join(", ")}.` : null}
            </FieldDescription>
            <FieldError>{errors.volumes?.[0]}</FieldError>
          </Field>
          <Field>
            <FieldLabel htmlFor="e-restart">Restart policy</FieldLabel>
            <Select name="restart" defaultValue={v.restart}>
              <SelectTrigger id="e-restart" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="no">Never</SelectItem>
                <SelectItem value="always">Always</SelectItem>
                <SelectItem value="unless-stopped">Unless stopped</SelectItem>
                <SelectItem value="on-failure">On failure</SelectItem>
              </SelectContent>
            </Select>
          </Field>
          {info.networksEditable ? (
            <FieldSet data-invalid={errors.networks ? true : undefined}>
              <FieldLegend variant="label">Networks</FieldLegend>
              <input type="hidden" name="networksShown" value="1" />
              <div className="grid gap-2 sm:grid-cols-2">
                {networks.map((n) => (
                  <Label key={n} className="font-normal">
                    <Checkbox name="networks" value={n} defaultChecked={v.networks.includes(n)} />
                    {n}
                  </Label>
                ))}
              </div>
              <FieldDescription>Aliases and static IPs of networks that stay attached are kept.</FieldDescription>
              <FieldError>{errors.networks?.[0]}</FieldError>
            </FieldSet>
          ) : (
            <p className="text-sm text-muted-foreground">
              Network mode <code>{info.networkMode}</code> is kept.
            </p>
          )}
          <Label className="font-normal">
            <Checkbox name="pull" value="on" />
            Pull the image before recreating
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
  return (
    <ConfirmAction
      open={open}
      onOpenChange={onOpenChange}
      title={`Pull & recreate ${name}?`}
      description={
        <>
          Pulls <code>{image}</code> and, if a newer image was downloaded, recreates the container with the same settings.
          It is stopped briefly while being replaced.
        </>
      }
      extra={composeProject ? <ComposeWarning project={composeProject} /> : undefined}
      confirmLabel="Pull & recreate"
      destructive={false}
      onConfirm={async () => {
        const res = await pullAndRecreateContainer(id)
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
        Pull & recreate
      </Button>
    </PullRecreateConfirm>
  )
}
