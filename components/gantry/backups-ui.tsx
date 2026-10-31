"use client"

import * as React from "react"
import { useActionState } from "react"
import { useRouter } from "next/navigation"
import { ArchiveRestoreIcon, DownloadIcon, PlayIcon, SaveIcon, Trash2Icon, TriangleAlertIcon } from "lucide-react"
import { toast } from "sonner"

import { backUpNow, deleteBackup, saveSchedule } from "@/app/(app)/backups/actions"
import { columnHelperFor, DataTable, SortHeader } from "@/components/data-table"
import { ConfirmAction } from "@/components/gantry/confirm-button"
import { Mono } from "@/components/gantry/ui"
import { submitKeepingValues, useRunAction } from "@/components/gantry/use-action"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Checkbox } from "@/components/ui/checkbox"
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import type { I18n } from "@/lib/i18n"
import { useI18n } from "@/lib/i18n/client"
import type { ActionState } from "@/lib/validation"

function Section({ children }: { children: React.ReactNode }) {
  return <div className="px-4 lg:px-6">{children}</div>
}

/** Saves a response body as a file in the browser. */
async function saveDownload(res: Response, fallback: string) {
  const name = /filename="([^"]+)"/.exec(res.headers.get("content-disposition") ?? "")?.[1] ?? fallback
  const url = URL.createObjectURL(await res.blob())
  const a = document.createElement("a")
  a.href = url
  a.download = name
  a.click()
  URL.revokeObjectURL(url)
  return name
}

export function BackupDownload({ minPassphrase }: { minPassphrase: number }) {
  const uid = React.useId()
  const { t, format } = useI18n()
  const [error, setError] = React.useState<string | null>(null)
  const [busy, setBusy] = React.useState(false)

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    const passphrase = String(form.get("passphrase") ?? "")
    if (passphrase.length < minPassphrase) return setError(format(t.backups.download.tooShort, { min: minPassphrase }))
    if (passphrase !== form.get("repeat")) return setError(t.backups.download.mismatch)
    setError(null)
    setBusy(true)
    try {
      const res = await fetch("/api/backup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ passphrase }),
      })
      if (!res.ok) throw new Error(((await res.json().catch(() => null)) as { error?: string } | null)?.error ?? t.backups.download.failed)
      toast.success(format(t.backups.download.downloaded, { name: await saveDownload(res, "gantry-backup.gbk") }))
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Section>
      <Card>
        <CardHeader>
          <CardTitle>{t.backups.download.title}</CardTitle>
          <CardDescription>{t.backups.download.description}</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={onSubmit} className="flex flex-wrap items-end gap-4">
            <Field className="w-64">
              <FieldLabel htmlFor={`${uid}-pass`}>{t.backups.download.passphrase}</FieldLabel>
              <Input id={`${uid}-pass`} name="passphrase" type="password" autoComplete="new-password" required />
            </Field>
            <Field className="w-64">
              <FieldLabel htmlFor={`${uid}-repeat`}>{t.backups.download.repeat}</FieldLabel>
              <Input id={`${uid}-repeat`} name="repeat" type="password" autoComplete="new-password" required />
            </Field>
            <Button type="submit" disabled={busy}>
              <DownloadIcon data-icon="inline-start" />
              {busy ? t.backups.download.preparing : t.backups.download.submit}
            </Button>
          </form>
          {error ? <FieldError className="mt-3">{error}</FieldError> : null}
        </CardContent>
      </Card>
    </Section>
  )
}

export function BackupSchedule({
  enabled,
  time,
  keep,
  hasPassphrase,
  directory,
  minPassphrase,
  last,
}: {
  enabled: boolean
  time: string
  keep: number
  hasPassphrase: boolean
  directory: string
  minPassphrase: number
  last: { label: string; name?: string; error?: string; trigger: string } | null
}) {
  const [state, formAction, saving] = useActionState<ActionState, FormData>(saveSchedule, {})
  const i18n = useI18n()
  const { t, format } = i18n
  const saved = t.common.status.saved
  React.useEffect(() => {
    if (state.ok) toast.success(state.message ?? saved)
    else if (state.error && !state.fieldErrors) toast.error(state.error)
  }, [state, saved])
  const [running, run] = useRunAction()
  const errs = state.fieldErrors ?? {}
  const uid = React.useId()

  return (
    <Section>
      <Card>
        <CardHeader>
          <CardTitle>{t.backups.schedule.title}</CardTitle>
          <CardDescription>
            {i18n.rich(t.backups.schedule.writtenTo, { directory: <Mono>{directory}</Mono>, env: <code>BACKUP_DIR</code> })}
            {last ? (
              last.error ? (
                <span className="mt-1 flex items-center gap-1.5 text-destructive" data-testid="backup-last">
                  <TriangleAlertIcon className="size-4" /> {format(t.backups.schedule.lastFailed, { when: last.label, error: last.error })}
                </span>
              ) : (
                <span className="mt-1 block" data-testid="backup-last">
                  {format(t.backups.schedule.last, { when: last.label, name: last.name ?? "" })}
                </span>
              )
            ) : null}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {/* No automatic form reset: the Radix checkbox would jump back to its first value. */}
          <form method="post" onSubmit={submitKeepingValues(formAction)} className="flex flex-col gap-4">
            <FieldGroup className="grid gap-4 @3xl/main:grid-cols-[auto_8rem_8rem_minmax(0,18rem)] @3xl/main:items-end">
              <Label className="h-8 font-normal">
                <Checkbox name="enabled" value="on" defaultChecked={enabled} />
                {t.backups.schedule.daily}
              </Label>
              <Field data-invalid={errs.time ? true : undefined}>
                <FieldLabel htmlFor={`${uid}-time`}>{t.backups.schedule.at}</FieldLabel>
                <Input id={`${uid}-time`} name="time" type="time" defaultValue={time} required />
                <FieldError>{errs.time?.[0]}</FieldError>
              </Field>
              <Field data-invalid={errs.keep ? true : undefined}>
                <FieldLabel htmlFor={`${uid}-keep`}>{t.backups.schedule.keep}</FieldLabel>
                <Input id={`${uid}-keep`} name="keep" type="number" min={1} max={365} defaultValue={keep} required />
                <FieldError>{errs.keep?.[0]}</FieldError>
              </Field>
              <Field data-invalid={errs.passphrase ? true : undefined}>
                <FieldLabel htmlFor={`${uid}-pass`}>{t.backups.download.passphrase}</FieldLabel>
                <Input
                  id={`${uid}-pass`}
                  name="passphrase"
                  type="password"
                  autoComplete="new-password"
                  placeholder={hasPassphrase ? t.backups.schedule.keepCurrent : format(t.backups.schedule.atLeast, { min: minPassphrase })}
                />
                <FieldError>{errs.passphrase?.[0]}</FieldError>
              </Field>
            </FieldGroup>
            <FieldDescription>{t.backups.schedule.help}</FieldDescription>
            <div className="flex flex-wrap gap-2">
              <Button type="submit" variant="outline" disabled={saving}>
                <SaveIcon data-icon="inline-start" />
                {saving ? t.common.status.saving : t.backups.schedule.save}
              </Button>
              <Button type="button" disabled={running || !hasPassphrase} onClick={() => run(backUpNow)}>
                <PlayIcon data-icon="inline-start" />
                {running ? t.backups.schedule.backingUp : t.backups.schedule.backUpNow}
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </Section>
  )
}

export type StoredBackupRow = { name: string; size: number; sizeLabel: string; createdAt: string; createdLabel: string }

const helper = columnHelperFor<StoredBackupRow>()
function storedColumns(i18n: I18n) {
  const { t, format } = i18n
  return helper.columns([
    helper.accessor("name", {
      header: ({ column }) => <SortHeader column={column} title={t.backups.stored.backup} />,
      cell: ({ row }) => <Mono>{row.original.name}</Mono>,
      enableHiding: false,
    }),
    helper.accessor("createdAt", {
      header: ({ column }) => <SortHeader column={column} title={t.backups.stored.columns.createdAt} />,
      cell: ({ row }) => <span className="text-muted-foreground">{row.original.createdLabel}</span>,
    }),
    helper.accessor("size", {
      header: ({ column }) => <SortHeader column={column} title={t.backups.stored.columns.size} />,
      cell: ({ row }) => <span className="tabular-nums">{row.original.sizeLabel}</span>,
    }),
    helper.display({
      id: "actions",
      enableHiding: false,
      cell: ({ row }) => (
        <div className="flex justify-end gap-1">
          <Button variant="ghost" size="icon" className="size-8 text-muted-foreground" asChild>
            <a href={`/api/backup/files/${row.original.name}`} download aria-label={format(t.backups.stored.downloadLabel, { name: row.original.name })}>
              <DownloadIcon />
            </a>
          </Button>
          <ConfirmAction
            title={format(t.backups.stored.deleteTitle, { name: row.original.name })}
            description={t.backups.stored.deleteDescription}
            confirmLabel={t.common.actions.delete}
            onConfirm={() => deleteBackup(row.original.name)}
          >
            <Button variant="ghost" size="icon" className="size-8 text-muted-foreground" aria-label={format(t.backups.stored.deleteLabel, { name: row.original.name })}>
              <Trash2Icon />
            </Button>
          </ConfirmAction>
        </div>
      ),
    }),
  ])
}

export function StoredBackupsTable({ data }: { data: StoredBackupRow[] }) {
  const i18n = useI18n()
  const columns = React.useMemo(() => storedColumns(i18n), [i18n])
  return (
    <DataTable
      data={data}
      columns={columns}
      getRowId={(r) => r.name}
      emptyMessage={i18n.t.backups.stored.empty}
      columnLabels={i18n.t.backups.stored.columns}
    />
  )
}

export function RestoreBackup() {
  const router = useRouter()
  const i18n = useI18n()
  const { t } = i18n
  const uid = React.useId()
  const [error, setError] = React.useState<string | null>(null)
  const [busy, setBusy] = React.useState(false)
  const [done, setDone] = React.useState<{ rows: number; restartRequired: boolean; createdAt: string } | null>(null)

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError(null)
    setBusy(true)
    try {
      const res = await fetch("/api/backup/restore", { method: "POST", body: new FormData(event.currentTarget) })
      const body = (await res.json().catch(() => null)) as { error?: string; rows: number; restartRequired: boolean; createdAt: string } | null
      if (!res.ok || !body) throw new Error(body?.error ?? t.backups.restore.failed)
      setDone(body)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Section>
      <Card className="border-destructive/30">
        <CardHeader>
          <CardTitle>{t.backups.restore.title}</CardTitle>
          <CardDescription>{t.backups.restore.description}</CardDescription>
        </CardHeader>
        <CardContent>
          {done ? (
            <div className="flex flex-col gap-3 text-sm" data-testid="restore-done">
              <p>
                {i18n.format(t.backups.restore.restored, {
                  rows: done.rows,
                  // English keeps the browser's own date format.
                  date: i18n.locale === "en" ? new Date(done.createdAt).toLocaleString() : i18n.formatDate(done.createdAt),
                })}
              </p>
              {done.restartRequired ? (
                <p className="flex items-center gap-2 font-medium text-destructive">
                  <TriangleAlertIcon className="size-4" />
                  {t.backups.restore.restartRequired}
                </p>
              ) : (
                <Button className="w-fit" onClick={() => router.replace("/login")}>
                  {t.backups.restore.signInAgain}
                </Button>
              )}
            </div>
          ) : (
            <form onSubmit={onSubmit} className="flex flex-wrap items-end gap-4">
              <Field className="w-72">
                <FieldLabel htmlFor={`${uid}-file`}>{t.backups.restore.file}</FieldLabel>
                <Input id={`${uid}-file`} name="file" type="file" accept=".gbk" required />
              </Field>
              <Field className="w-56">
                <FieldLabel htmlFor={`${uid}-pass`}>{t.backups.download.passphrase}</FieldLabel>
                <Input id={`${uid}-pass`} name="passphrase" type="password" autoComplete="off" required />
              </Field>
              <Field className="w-40">
                <FieldLabel htmlFor={`${uid}-confirm`}>{t.backups.restore.typeRestore}</FieldLabel>
                <Input id={`${uid}-confirm`} name="confirm" autoComplete="off" pattern="RESTORE" required />
              </Field>
              <Button type="submit" variant="destructive" disabled={busy}>
                <ArchiveRestoreIcon data-icon="inline-start" />
                {busy ? t.backups.restore.restoring : t.backups.restore.submit}
              </Button>
            </form>
          )}
          {error ? <FieldError className="mt-3">{error}</FieldError> : null}
        </CardContent>
      </Card>
    </Section>
  )
}
