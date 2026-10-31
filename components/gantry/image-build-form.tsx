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
  BUILD_OPTIONS_HEADER,
  DEFAULT_DOCKERFILE,
  EXAMPLE_DOCKERFILE,
  isArchiveName,
  MAX_EXTRA_FILES,
  MAX_OPTIONS_HEADER,
  type FieldErrors,
} from "@/lib/image-build"

export type SourceKind = "editor" | "upload" | "git"

/** Form values; a rebuild starts from those of an earlier build (never with credentials or the archive). */
export type BuildFormValues = {
  kind: SourceKind
  dockerfile: string
  files: { path: string; content: string }[]
  uploadDockerfile: string
  url: string
  ref: string
  context: string
  gitDockerfile: string
  tags: string
  buildArgs: string
  labels: string
  target: string
  noCache: boolean
  pull: boolean
  push: boolean
}

export const EMPTY_BUILD_FORM: BuildFormValues = {
  kind: "editor",
  dockerfile: EXAMPLE_DOCKERFILE,
  files: [],
  uploadDockerfile: DEFAULT_DOCKERFILE,
  url: "",
  ref: "main",
  context: "",
  gitDockerfile: DEFAULT_DOCKERFILE,
  tags: "",
  buildArgs: "",
  labels: "",
  target: "",
  noCache: false,
  pull: false,
  push: false,
}

const monoArea = "font-mono text-xs leading-relaxed md:text-xs"

const subscribeNothing = () => () => {}

/**
 * Build form (/images/build): the source (Dockerfile editor, uploaded
 * archive or Git repository) and options, then the live build output.
 * Sent with fetch (no form action), so nothing resets after a failed
 * attempt; inactive tabs stay mounted (hidden) and keep what was typed.
 */
export function ImageBuildForm({ initial, rebuildOf }: { initial: BuildFormValues; rebuildOf?: number }) {
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
  const err = (key: string) => errors[key]?.[0]
  const invalid = (key: string) => (errors[key] ? true : undefined)

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
    const options = {
      tags: field("tags"),
      buildArgs: field("buildArgs"),
      labels: field("labels"),
      target: field("target"),
      noCache: values.noCache,
      pull: values.pull,
      push: values.push,
    }
    let request: [string, RequestInit]
    if (values.kind === "upload") {
      if (!archive) return setErrors({ archive: ["Choose a .tar or .tar.gz archive"] })
      if (!isArchiveName(archive.name)) return setErrors({ archive: ["Choose a .tar or .tar.gz archive"] })
      const header = encodeURIComponent(
        JSON.stringify({ environmentId, filename: archive.name, dockerfile: field("uploadDockerfile"), options })
      )
      if (header.length > MAX_OPTIONS_HEADER) {
        return setFormError("The build arguments and labels are too long to send with an upload")
      }
      request = [
        "/api/images/build/upload",
        { method: "POST", body: archive, headers: { "Content-Type": "application/octet-stream", [BUILD_OPTIONS_HEADER]: header } },
      ]
    } else {
      const source =
        values.kind === "editor"
          ? { kind: "editor", dockerfile: field("dockerfile"), files: values.files }
          : {
              kind: "git",
              url: field("url"),
              ref: field("ref"),
              context: field("context"),
              dockerfile: field("gitDockerfile"),
              username: field("username"),
              token: field("token"),
            }
      request = [
        "/api/images/build",
        { method: "POST", body: JSON.stringify({ environmentId, source, options }), headers: { "Content-Type": "application/json" } },
      ]
    }
    outputRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" })
    const failure = await start(...request)
    if (failure) {
      setErrors(failure.fieldErrors ?? {})
      setFormError(failure.fieldErrors ? null : failure.error)
    }
  }

  const busy = state.running

  return (
    <div className="grid gap-4 px-4 lg:px-6">
      <form onSubmit={submit} className="grid gap-4" aria-label="Build image">
        <Card>
          <CardHeader>
            <CardTitle>Source</CardTitle>
            <CardDescription>
              {rebuildOf ? `Prefilled from build #${rebuildOf}. ` : null}
              What Docker builds from: the build context and its Dockerfile.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Tabs value={values.kind} onValueChange={(v) => set("kind", v as SourceKind)}>
              <TabsList>
                <TabsTrigger value="editor" disabled={busy}>
                  Dockerfile
                </TabsTrigger>
                <TabsTrigger value="upload" disabled={busy}>
                  Upload archive
                </TabsTrigger>
                <TabsTrigger value="git" disabled={busy}>
                  Git repository
                </TabsTrigger>
              </TabsList>

              <TabsContent value="editor" forceMount className="pt-3 data-[state=inactive]:hidden">
                <FieldGroup>
                  <Field data-invalid={invalid("dockerfile")}>
                    <FieldLabel htmlFor={id("dockerfile")}>Dockerfile</FieldLabel>
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
                  <ExtraFiles
                    files={values.files}
                    onChange={(files) => set("files", files)}
                    disabled={busy}
                    error={err("files")}
                    idPrefix={id("file")}
                  />
                </FieldGroup>
              </TabsContent>

              <TabsContent value="upload" forceMount className="pt-3 data-[state=inactive]:hidden">
                <FieldGroup>
                  <Field data-invalid={invalid("archive")}>
                    <FieldLabel htmlFor={id("archive")}>Build context archive</FieldLabel>
                    <Input
                      id={id("archive")}
                      type="file"
                      accept=".tar,.tar.gz,.tgz,application/x-tar,application/gzip"
                      onChange={(e) => setArchive(e.target.files?.[0] ?? null)}
                      disabled={busy}
                      aria-invalid={invalid("archive")}
                    />
                    <FieldDescription>
                      A .tar or .tar.gz of the folder you would run <code>docker build</code> in. It is streamed to Docker
                      and not kept by Gantry.
                    </FieldDescription>
                    <FieldError>{err("archive")}</FieldError>
                  </Field>
                  <Field data-invalid={invalid("uploadDockerfile")} className="max-w-md">
                    <FieldLabel htmlFor={id("uploadDockerfile")}>Dockerfile path</FieldLabel>
                    <Input
                      id={id("uploadDockerfile")}
                      defaultValue={initial.uploadDockerfile}
                      placeholder={DEFAULT_DOCKERFILE}
                      spellCheck={false}
                      disabled={busy}
                      aria-invalid={invalid("uploadDockerfile")}
                    />
                    <FieldDescription>Inside the archive.</FieldDescription>
                    <FieldError>{err("uploadDockerfile")}</FieldError>
                  </Field>
                </FieldGroup>
              </TabsContent>

              <TabsContent value="git" forceMount className="pt-3 data-[state=inactive]:hidden">
                <FieldGroup>
                  <Field data-invalid={invalid("url")}>
                    <FieldLabel htmlFor={id("url")}>Repository URL</FieldLabel>
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
                      <FieldLabel htmlFor={id("ref")}>Branch, tag or commit</FieldLabel>
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
                      <FieldLabel htmlFor={id("context")}>Context directory</FieldLabel>
                      <Input
                        id={id("context")}
                        defaultValue={initial.context}
                        placeholder="(repository root)"
                        spellCheck={false}
                        disabled={busy}
                        aria-invalid={invalid("context")}
                      />
                      <FieldError>{err("context")}</FieldError>
                    </Field>
                    <Field data-invalid={invalid("gitDockerfile")}>
                      <FieldLabel htmlFor={id("gitDockerfile")}>Dockerfile path</FieldLabel>
                      <Input
                        id={id("gitDockerfile")}
                        defaultValue={initial.gitDockerfile}
                        placeholder={DEFAULT_DOCKERFILE}
                        spellCheck={false}
                        disabled={busy}
                        aria-invalid={invalid("gitDockerfile")}
                      />
                      <FieldDescription>Relative to the context directory.</FieldDescription>
                      <FieldError>{err("gitDockerfile")}</FieldError>
                    </Field>
                  </div>
                  <div className="grid gap-4 @3xl/main:grid-cols-2">
                    <Field data-invalid={invalid("username")}>
                      <FieldLabel htmlFor={id("username")}>Username</FieldLabel>
                      <Input
                        id={id("username")}
                                                autoComplete="off"
                        spellCheck={false}
                        disabled={busy}
                        aria-invalid={invalid("username")}
                      />
                      <FieldError>{err("username")}</FieldError>
                    </Field>
                    <Field data-invalid={invalid("token")}>
                      <FieldLabel htmlFor={id("token")}>Access token</FieldLabel>
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
                  <FieldDescription>
                    Private repositories only. The login is used for this clone and never stored, so a rebuild asks for
                    it again.
                  </FieldDescription>
                </FieldGroup>
              </TabsContent>
            </Tabs>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Options</CardTitle>
          </CardHeader>
          <CardContent>
            <FieldGroup>
              <Field data-invalid={invalid("tags")}>
                <FieldLabel htmlFor={id("tags")}>Tags</FieldLabel>
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
                <FieldDescription>One per line; :latest when no tag is given. Prefix a registry to push there.</FieldDescription>
                <FieldError>{err("tags")}</FieldError>
              </Field>
              <div className="grid gap-4 @3xl/main:grid-cols-2">
                <Field data-invalid={invalid("buildArgs")}>
                  <FieldLabel htmlFor={id("buildArgs")}>Build arguments</FieldLabel>
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
                  <FieldDescription>
                    KEY=value per line, for ARG. Not for secrets: they stay visible in the image history and in
                    Gantry&apos;s build history.
                  </FieldDescription>
                  <FieldError>{err("buildArgs")}</FieldError>
                </Field>
                <Field data-invalid={invalid("labels")}>
                  <FieldLabel htmlFor={id("labels")}>Labels</FieldLabel>
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
                  <FieldDescription>KEY=value per line, added to the image.</FieldDescription>
                  <FieldError>{err("labels")}</FieldError>
                </Field>
              </div>
              <Field data-invalid={invalid("target")} className="max-w-sm">
                <FieldLabel htmlFor={id("target")}>Target stage</FieldLabel>
                <Input
                  id={id("target")}
                  defaultValue={initial.target}
                  placeholder="(last stage)"
                  spellCheck={false}
                  disabled={busy}
                  aria-invalid={invalid("target")}
                />
                <FieldError>{err("target")}</FieldError>
              </Field>
              <div className="flex flex-wrap gap-x-6 gap-y-3">
                <Label className="font-normal">
                  <Checkbox checked={values.noCache} onCheckedChange={(v) => set("noCache", v === true)} disabled={busy} />
                  No cache
                </Label>
                <Label className="font-normal">
                  <Checkbox checked={values.pull} onCheckedChange={(v) => set("pull", v === true)} disabled={busy} />
                  Always pull base images
                </Label>
                <Label className="font-normal">
                  <Checkbox checked={values.push} onCheckedChange={(v) => set("push", v === true)} disabled={busy} />
                  Push after build
                </Label>
              </div>
              {formError ? <FieldError>{formError}</FieldError> : null}
              {Object.keys(errors).length ? <FieldError>Please fix the highlighted fields</FieldError> : null}
              <Field orientation="horizontal">
                {busy ? (
                  <Button type="button" variant="destructive" onClick={cancel}>
                    <SquareIcon data-icon="inline-start" />
                    Cancel build
                  </Button>
                ) : (
                  <Button type="submit" disabled={!hydrated}>
                    <HammerIcon data-icon="inline-start" />
                    Build image
                  </Button>
                )}
              </Field>
            </FieldGroup>
          </CardContent>
        </Card>
      </form>

      <Card ref={outputRef}>
        <CardHeader>
          <CardTitle>Output</CardTitle>
          <CardDescription>
            Streams live while the build runs. Leaving this page or closing the tab cancels the build.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3">
          {busy ? <RunningNote text={state.buildId ? `Build #${state.buildId} running…` : "Starting…"} /> : null}
          {done ? <StreamResult done={done} what="build" /> : null}
          <StreamLog state={state} label="Build log" />
        </CardContent>
      </Card>
    </div>
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
  const update = (i: number, patch: Partial<{ path: string; content: string }>) =>
    onChange(files.map((f, j) => (j === i ? { ...f, ...patch } : f)))
  return (
    <Field data-invalid={error ? true : undefined}>
      <p className="text-sm font-medium">Extra files</p>
      <FieldDescription>
        Small files next to the Dockerfile, for COPY (e.g. <code>app/config.json</code>). Upload an archive for anything
        bigger.
      </FieldDescription>
      {files.map((f, i) => (
        <div key={i} className="grid gap-2 rounded-lg border p-3">
          <div className="flex items-end gap-2">
            <div className="grid flex-1 gap-1">
              <Label htmlFor={`${idPrefix}-${i}-path`}>File {i + 1} path</Label>
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
              aria-label={`Remove file ${i + 1}`}
              onClick={() => onChange(files.filter((_, j) => j !== i))}
              disabled={disabled}
            >
              <Trash2Icon />
            </Button>
          </div>
          <Label htmlFor={`${idPrefix}-${i}-content`} className="sr-only">
            File {i + 1} content
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
        Add file
      </Button>
      <FieldError>{error}</FieldError>
    </Field>
  )
}
