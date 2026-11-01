"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { HammerIcon, PlusIcon, SquareIcon, Trash2Icon } from "lucide-react"

import { useEnvironmentId } from "@/components/gantry/environment-scope"
import { RunningNote, StreamLog, StreamResult, useImageStream } from "@/components/gantry/image-stream"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Checkbox } from "@/components/ui/checkbox"
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Textarea } from "@/components/ui/textarea"
import {
  buildFormRequest,
  DEFAULT_DOCKERFILE,
  MAX_EXTRA_FILES,
  type BuildFormValues,
  type EditorFile,
  type FieldErrors,
  type SourceKind,
} from "@/lib/image-build"
import { useI18n } from "@/lib/i18n/client"

const monoArea = "font-mono text-xs leading-relaxed md:text-xs"

const subscribeNothing = () => () => {}

/** Ids and error state of the form's fields, shared by its sections. */
type FieldKit = {
  /** The element id of a field (also how submit reads it). */
  id: (name: string) => string
  /** The first error of a field. */
  err: (key: string) => string | undefined
  /** aria-invalid / data-invalid of a field. */
  invalid: (key: string) => true | undefined
  /** A build is running: everything is disabled. */
  busy: boolean
}

type Toggles = { noCache: boolean; pull: boolean; push: boolean }

/**
 * Build form (/images/build): the source (Dockerfile editor, uploaded
 * archive or Git repository) and options, then the live build output.
 * Sent with fetch (no form action), so nothing resets after a failed
 * attempt; inactive tabs stay mounted (hidden) and keep what was typed.
 */
export function ImageBuildForm({ initial, rebuildOf }: { initial: BuildFormValues; rebuildOf?: number }) {
  const i18n = useI18n()
  const { t } = i18n
  const text = t.images.build
  const environmentId = useEnvironmentId()
  const router = useRouter()
  const uid = React.useId()
  const id = (name: string) => `${uid}-${name}`
  // Text fields are uncontrolled (read on submit), so whatever was typed
  // before hydration stays. Tabs, extra files and checkboxes are state.
  const [values, setValues] = React.useState(() => ({
    kind: initial.kind,
    files: initial.files,
    noCache: initial.noCache,
    pull: initial.pull,
    push: initial.push,
  }))
  const [archive, setArchive] = React.useState<File | null>(null)
  // Nothing submits before hydration (the form has no action; fields have no
  // names, so a token can never end up in a URL).
  const hydrated = React.useSyncExternalStore(
    subscribeNothing,
    () => true,
    () => false
  )
  const [errors, setErrors] = React.useState<FieldErrors>({})
  const [formError, setFormError] = React.useState<string | null>(null)
  const { state, start, cancel } = useImageStream()
  const outputRef = React.useRef<HTMLDivElement>(null)

  const set = <K extends keyof typeof values>(key: K, value: (typeof values)[K]) => setValues((v) => ({ ...v, [key]: value }))

  const done = state.done
  React.useEffect(() => {
    // The history list below picks up the new entry.
    if (done) router.refresh()
  }, [done, router])

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (state.running) return
    setErrors({})
    setFormError(null)
    const form = event.currentTarget
    const field = (key: string) => {
      const el = form.elements.namedItem(id(key))
      return el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement ? el.value : ""
    }
    const request = buildFormRequest({ ...values, archive, environmentId }, field)
    if (!request.ok) {
      return request.error === "archive" ? setErrors({ archive: [text.chooseArchive] }) : setFormError(text.optionsTooLong)
    }
    outputRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" })
    const failure = await start(request.url, request.init)
    if (failure) {
      setErrors(failure.fieldErrors ?? {})
      setFormError(failure.fieldErrors ? null : failure.error)
    }
  }

  const busy = state.running
  const kit: FieldKit = {
    id,
    err: (key) => errors[key]?.[0],
    invalid: (key) => (errors[key] ? true : undefined),
    busy,
  }

  return (
    <div className="grid gap-4 px-4 lg:px-6">
      <form onSubmit={submit} className="grid gap-4" aria-label={text.submit}>
        <Card>
          <CardHeader>
            <CardTitle>{text.source}</CardTitle>
            <CardDescription>
              {rebuildOf ? i18n.format(text.prefilled, { id: rebuildOf }) : null}
              {text.sourceDescription}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Tabs value={values.kind} onValueChange={(v) => set("kind", v as SourceKind)}>
              <TabsList>
                <TabsTrigger value="editor" disabled={busy}>
                  {text.tabEditor}
                </TabsTrigger>
                <TabsTrigger value="upload" disabled={busy}>
                  {text.tabUpload}
                </TabsTrigger>
                <TabsTrigger value="git" disabled={busy}>
                  {text.tabGit}
                </TabsTrigger>
              </TabsList>

              <TabsContent value="editor" forceMount className="pt-3 data-[state=inactive]:hidden">
                <EditorSourceFields kit={kit} initial={initial} files={values.files} onFilesChange={(files) => set("files", files)} />
              </TabsContent>
              <TabsContent value="upload" forceMount className="pt-3 data-[state=inactive]:hidden">
                <UploadSourceFields kit={kit} initial={initial} onArchiveChange={setArchive} />
              </TabsContent>
              <TabsContent value="git" forceMount className="pt-3 data-[state=inactive]:hidden">
                <GitSourceFields kit={kit} initial={initial} />
              </TabsContent>
            </Tabs>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>{text.options}</CardTitle>
          </CardHeader>
          <CardContent>
            <FieldGroup>
              <OptionFields kit={kit} initial={initial} toggles={values} onToggle={set} />
              {formError ? <FieldError>{formError}</FieldError> : null}
              {Object.keys(errors).length ? <FieldError>{t.common.errors.fixFields}</FieldError> : null}
              <Field orientation="horizontal">
                {busy ? (
                  // Distinct keys: reusing one <button> would let the click that
                  // cancels turn it into "submit" and start the build again.
                  <Button
                    key="cancel"
                    type="button"
                    variant="destructive"
                    onClick={(e) => {
                      e.preventDefault()
                      cancel()
                    }}
                  >
                    <SquareIcon data-icon="inline-start" />
                    {text.cancel}
                  </Button>
                ) : (
                  <Button key="build" type="submit" disabled={!hydrated}>
                    <HammerIcon data-icon="inline-start" />
                    {text.submit}
                  </Button>
                )}
              </Field>
            </FieldGroup>
          </CardContent>
        </Card>
      </form>

      <Card ref={outputRef}>
        <CardHeader>
          <CardTitle>{text.output}</CardTitle>
          <CardDescription>{text.outputDescription}</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3">
          {busy ? <RunningNote text={state.buildId ? i18n.format(text.running, { id: state.buildId }) : t.images.stream.starting} /> : null}
          {done ? <StreamResult done={done} what="build" /> : null}
          <StreamLog state={state} label={text.log} />
        </CardContent>
      </Card>
    </div>
  )
}

/** Editor tab: the Dockerfile and extra files next to it. */
function EditorSourceFields({
  kit: { id, err, invalid, busy },
  initial,
  files,
  onFilesChange,
}: {
  kit: FieldKit
  initial: BuildFormValues
  files: EditorFile[]
  onFilesChange: (files: EditorFile[]) => void
}) {
  const text = useI18n().t.images.build
  return (
    <FieldGroup>
      <Field data-invalid={invalid("dockerfile")}>
        <FieldLabel htmlFor={id("dockerfile")}>{text.dockerfile}</FieldLabel>
        <Textarea
          id={id("dockerfile")}
          defaultValue={initial.dockerfile}
          className={`max-h-[60vh] min-h-56 ${monoArea}`}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          wrap="off"
          disabled={busy}
          aria-invalid={invalid("dockerfile")}
        />
        <FieldError>{err("dockerfile")}</FieldError>
      </Field>
      <ExtraFiles files={files} onChange={onFilesChange} disabled={busy} error={err("files")} idPrefix={id("file")} />
    </FieldGroup>
  )
}

/** Upload tab: the archive (state, sent as the body) and the Dockerfile in it. */
function UploadSourceFields({
  kit: { id, err, invalid, busy },
  initial,
  onArchiveChange,
}: {
  kit: FieldKit
  initial: BuildFormValues
  onArchiveChange: (file: File | null) => void
}) {
  const i18n = useI18n()
  const text = i18n.t.images.build
  return (
    <FieldGroup>
      <Field data-invalid={invalid("archive")}>
        <FieldLabel htmlFor={id("archive")}>{text.archive}</FieldLabel>
        <Input
          id={id("archive")}
          type="file"
          accept=".tar,.tar.gz,.tgz,application/x-tar,application/gzip"
          onChange={(e) => onArchiveChange(e.target.files?.[0] ?? null)}
          disabled={busy}
          aria-invalid={invalid("archive")}
        />
        <FieldDescription>
          {i18n.rich(text.archiveHelp, { command: <code>docker build</code> })}
        </FieldDescription>
        <FieldError>{err("archive")}</FieldError>
      </Field>
      <Field data-invalid={invalid("uploadDockerfile")} className="max-w-md">
        <FieldLabel htmlFor={id("uploadDockerfile")}>{text.dockerfilePath}</FieldLabel>
        <Input
          id={id("uploadDockerfile")}
          defaultValue={initial.uploadDockerfile}
          placeholder={DEFAULT_DOCKERFILE}
          spellCheck={false}
          disabled={busy}
          aria-invalid={invalid("uploadDockerfile")}
        />
        <FieldDescription>{text.insideArchive}</FieldDescription>
        <FieldError>{err("uploadDockerfile")}</FieldError>
      </Field>
    </FieldGroup>
  )
}

/** Git tab: repository, ref, context, Dockerfile and an optional login (never prefilled). */
function GitSourceFields({ kit: { id, err, invalid, busy }, initial }: { kit: FieldKit; initial: BuildFormValues }) {
  const text = useI18n().t.images.build
  return (
    <FieldGroup>
      <Field data-invalid={invalid("url")}>
        <FieldLabel htmlFor={id("url")}>{text.repositoryUrl}</FieldLabel>
        <Input
          id={id("url")}
          defaultValue={initial.url}
          placeholder="https://github.com/owner/repo.git"
          spellCheck={false}
          autoComplete="off"
          disabled={busy}
          aria-invalid={invalid("url")}
        />
        <FieldError>{err("url")}</FieldError>
      </Field>
      <div className="grid gap-4 @3xl/main:grid-cols-3">
        <Field data-invalid={invalid("ref")}>
          <FieldLabel htmlFor={id("ref")}>{text.ref}</FieldLabel>
          <Input
            id={id("ref")}
            defaultValue={initial.ref}
            placeholder="main"
            spellCheck={false}
            disabled={busy}
            aria-invalid={invalid("ref")}
          />
          <FieldError>{err("ref")}</FieldError>
        </Field>
        <Field data-invalid={invalid("context")}>
          <FieldLabel htmlFor={id("context")}>{text.contextDirectory}</FieldLabel>
          <Input
            id={id("context")}
            defaultValue={initial.context}
            placeholder={text.repositoryRoot}
            spellCheck={false}
            disabled={busy}
            aria-invalid={invalid("context")}
          />
          <FieldError>{err("context")}</FieldError>
        </Field>
        <Field data-invalid={invalid("gitDockerfile")}>
          <FieldLabel htmlFor={id("gitDockerfile")}>{text.dockerfilePath}</FieldLabel>
          <Input
            id={id("gitDockerfile")}
            defaultValue={initial.gitDockerfile}
            placeholder={DEFAULT_DOCKERFILE}
            spellCheck={false}
            disabled={busy}
            aria-invalid={invalid("gitDockerfile")}
          />
          <FieldDescription>{text.relativeToContext}</FieldDescription>
          <FieldError>{err("gitDockerfile")}</FieldError>
        </Field>
      </div>
      <div className="grid gap-4 @3xl/main:grid-cols-2">
        <Field data-invalid={invalid("username")}>
          <FieldLabel htmlFor={id("username")}>{text.username}</FieldLabel>
          <Input id={id("username")} autoComplete="off" spellCheck={false} disabled={busy} aria-invalid={invalid("username")} />
          <FieldError>{err("username")}</FieldError>
        </Field>
        <Field data-invalid={invalid("token")}>
          <FieldLabel htmlFor={id("token")}>{text.accessToken}</FieldLabel>
          <Input
            id={id("token")}
            type="password"
            autoComplete="new-password"
            disabled={busy}
            aria-invalid={invalid("token")}
          />
          <FieldError>{err("token")}</FieldError>
        </Field>
      </div>
      <FieldDescription>{text.gitLoginHelp}</FieldDescription>
    </FieldGroup>
  )
}

/** Tags, build arguments, labels, target stage and the three checkboxes. */
function OptionFields({
  kit: { id, err, invalid, busy },
  initial,
  toggles,
  onToggle,
}: {
  kit: FieldKit
  initial: BuildFormValues
  toggles: Toggles
  onToggle: (key: keyof Toggles, value: boolean) => void
}) {
  const text = useI18n().t.images.build
  return (
    <>
      <Field data-invalid={invalid("tags")}>
        <FieldLabel htmlFor={id("tags")}>{text.tags}</FieldLabel>
        <Textarea
          id={id("tags")}
          defaultValue={initial.tags}
          placeholder={"my-app:1.0\nregistry.example.com/team/my-app:1.0"}
          className={`min-h-16 ${monoArea}`}
          spellCheck={false}
          autoCapitalize="off"
          disabled={busy}
          aria-invalid={invalid("tags")}
        />
        <FieldDescription>{text.tagsHelp}</FieldDescription>
        <FieldError>{err("tags")}</FieldError>
      </Field>
      <div className="grid gap-4 @3xl/main:grid-cols-2">
        <Field data-invalid={invalid("buildArgs")}>
          <FieldLabel htmlFor={id("buildArgs")}>{text.buildArgs}</FieldLabel>
          <Textarea
            id={id("buildArgs")}
            defaultValue={initial.buildArgs}
            placeholder="VERSION=1.0"
            className={`min-h-20 ${monoArea}`}
            spellCheck={false}
            autoCapitalize="off"
            wrap="off"
            disabled={busy}
            aria-invalid={invalid("buildArgs")}
          />
          <FieldDescription>{text.buildArgsHelp}</FieldDescription>
          <FieldError>{err("buildArgs")}</FieldError>
        </Field>
        <Field data-invalid={invalid("labels")}>
          <FieldLabel htmlFor={id("labels")}>{text.labels}</FieldLabel>
          <Textarea
            id={id("labels")}
            defaultValue={initial.labels}
            placeholder="org.opencontainers.image.source=https://…"
            className={`min-h-20 ${monoArea}`}
            spellCheck={false}
            autoCapitalize="off"
            wrap="off"
            disabled={busy}
            aria-invalid={invalid("labels")}
          />
          <FieldDescription>{text.labelsHelp}</FieldDescription>
          <FieldError>{err("labels")}</FieldError>
        </Field>
      </div>
      <Field data-invalid={invalid("target")} className="max-w-sm">
        <FieldLabel htmlFor={id("target")}>{text.target}</FieldLabel>
        <Input
          id={id("target")}
          defaultValue={initial.target}
          placeholder={text.lastStage}
          spellCheck={false}
          disabled={busy}
          aria-invalid={invalid("target")}
        />
        <FieldError>{err("target")}</FieldError>
      </Field>
      <div className="flex flex-wrap gap-x-6 gap-y-3">
        <Label className="font-normal">
          <Checkbox checked={toggles.noCache} onCheckedChange={(v) => onToggle("noCache", v === true)} disabled={busy} />
          {text.noCache}
        </Label>
        <Label className="font-normal">
          <Checkbox checked={toggles.pull} onCheckedChange={(v) => onToggle("pull", v === true)} disabled={busy} />
          {text.pull}
        </Label>
        <Label className="font-normal">
          <Checkbox checked={toggles.push} onCheckedChange={(v) => onToggle("push", v === true)} disabled={busy} />
          {text.push}
        </Label>
      </div>
    </>
  )
}

function ExtraFiles({
  files,
  onChange,
  disabled,
  error,
  idPrefix,
}: {
  files: { path: string; content: string }[]
  onChange: (files: { path: string; content: string }[]) => void
  disabled: boolean
  error?: string
  idPrefix: string
}) {
  const i18n = useI18n()
  const text = i18n.t.images.build
  const update = (i: number, patch: Partial<{ path: string; content: string }>) =>
    onChange(files.map((f, j) => (j === i ? { ...f, ...patch } : f)))
  return (
    <Field data-invalid={error ? true : undefined}>
      <p className="text-sm font-medium">{text.extraFiles}</p>
      <FieldDescription>
        {i18n.rich(text.extraFilesHelp, { example: <code>app/config.json</code> })}
      </FieldDescription>
      {files.map((f, i) => (
        <div key={i} className="grid gap-2 rounded-lg border p-3">
          <div className="flex items-end gap-2">
            <div className="grid flex-1 gap-1">
              <Label htmlFor={`${idPrefix}-${i}-path`}>{i18n.format(text.filePath, { number: i + 1 })}</Label>
              <Input
                id={`${idPrefix}-${i}-path`}
                value={f.path}
                onChange={(e) => update(i, { path: e.target.value })}
                placeholder="app/config.json"
                spellCheck={false}
                disabled={disabled}
              />
            </div>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label={i18n.format(text.removeFile, { number: i + 1 })}
              onClick={() => onChange(files.filter((_, j) => j !== i))}
              disabled={disabled}
            >
              <Trash2Icon />
            </Button>
          </div>
          <Label htmlFor={`${idPrefix}-${i}-content`} className="sr-only">
            {i18n.format(text.fileContent, { number: i + 1 })}
          </Label>
          <Textarea
            id={`${idPrefix}-${i}-content`}
            value={f.content}
            onChange={(e) => update(i, { content: e.target.value })}
            className={`min-h-24 ${monoArea}`}
            spellCheck={false}
            wrap="off"
            disabled={disabled}
          />
        </div>
      ))}
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="w-fit"
        onClick={() => onChange([...files, { path: "", content: "" }])}
        disabled={disabled || files.length >= MAX_EXTRA_FILES}
      >
        <PlusIcon data-icon="inline-start" />
        {text.addFile}
      </Button>
      <FieldError>{error}</FieldError>
    </Field>
  )
}
