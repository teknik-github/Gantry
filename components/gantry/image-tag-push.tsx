"use client"

import * as React from "react"
import { SquareIcon, TagIcon, UploadIcon } from "lucide-react"

import { tagImage } from "@/app/(app)/images/tag-actions"
import { useEnvironmentId } from "@/components/gantry/environment-scope"
import { FormDialog } from "@/components/gantry/form-dialog"
import { RunningNote, StreamLog, StreamResult, useImageStream } from "@/components/gantry/image-stream"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { registryOf } from "@/lib/registry"

// Row actions of the Images table: Tag (Server Action) and Push (streamed
// from /api/images/push with the matching registry's stored login).

type Row = { id: string; shortId: string; tags: string[] }

export function ImageTagPushActions({ row }: { row: Row }) {
  return (
    <>
      <TagImageDialog row={row} />
      <PushImageDialog row={row} />
    </>
  )
}

const label = (row: Row) => row.tags[0] ?? row.shortId

function TagImageDialog({ row }: { row: Row }) {
  const inputId = React.useId()
  return (
    <FormDialog
      trigger={
        <Button variant="ghost" size="icon" className="size-8 text-muted-foreground" aria-label={`Tag ${label(row)}`}>
          <TagIcon />
        </Button>
      }
      title={`Tag ${label(row)}`}
      description="Adds another name to this image, e.g. to push it to a registry."
      submitLabel="Tag"
      action={tagImage}
    >
      {(errors) => (
        <>
          <input type="hidden" name="id" value={row.id} />
          <Field data-invalid={errors.reference ? true : undefined}>
            <FieldLabel htmlFor={inputId}>New tag</FieldLabel>
            <Input
              id={inputId}
              name="reference"
              placeholder="registry.example.com/team/app:1.0"
              autoComplete="off"
              spellCheck={false}
              required
              autoFocus
              aria-invalid={errors.reference ? true : undefined}
            />
            <FieldDescription>
              Prefix a registry (host[:port]/) to push there; :latest when no tag is given.
            </FieldDescription>
            <FieldError>{errors.reference?.[0]}</FieldError>
          </Field>
        </>
      )}
    </FormDialog>
  )
}

function PushImageDialog({ row }: { row: Row }) {
  const [open, setOpen] = React.useState(false)
  const disabled = row.tags.length === 0
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="size-8 text-muted-foreground"
          aria-label={`Push ${label(row)}`}
          title={disabled ? "Tag the image first" : undefined}
          disabled={disabled}
        >
          <UploadIcon />
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-2xl">
        {/* Mounted while open only: closing the dialog cancels a running push. */}
        {open ? <PushBody row={row} /> : null}
      </DialogContent>
    </Dialog>
  )
}

function PushBody({ row }: { row: Row }) {
  const environmentId = useEnvironmentId()
  const selectId = React.useId()
  const [reference, setReference] = React.useState(row.tags[0] ?? "")
  const [error, setError] = React.useState<string | null>(null)
  const { state, start, cancel } = useImageStream()

  async function push() {
    setError(null)
    const failure = await start("/api/images/push", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reference, environmentId }),
    })
    if (failure) setError(failure.error)
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle>Push {label(row)}</DialogTitle>
        <DialogDescription>
          Uploads a tag to its registry with the login stored under Registries for that address.
        </DialogDescription>
      </DialogHeader>
      <Field>
        <FieldLabel htmlFor={selectId}>Tag to push</FieldLabel>
        <Select value={reference} onValueChange={setReference} disabled={state.running}>
          <SelectTrigger id={selectId} className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {row.tags.map((t) => (
              <SelectItem key={t} value={t}>
                {t}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <FieldDescription>
          Registry: <span className="font-mono">{reference ? registryOf(reference) : "?"}</span>. Closing this dialog
          cancels a running push.
        </FieldDescription>
      </Field>
      {error ? <FieldError>{error}</FieldError> : null}
      {state.running ? <RunningNote text={`Pushing ${reference}…`} /> : null}
      {state.done ? <StreamResult done={state.done} what="push" /> : null}
      {state.running || state.segments.length ? <StreamLog state={state} label="Push log" /> : null}
      <DialogFooter>
        {state.running ? (
          <Button type="button" variant="destructive" onClick={cancel}>
            <SquareIcon data-icon="inline-start" />
            Cancel push
          </Button>
        ) : (
          <Button type="button" onClick={push} disabled={!reference}>
            <UploadIcon data-icon="inline-start" />
            Push
          </Button>
        )}
      </DialogFooter>
    </>
  )
}
