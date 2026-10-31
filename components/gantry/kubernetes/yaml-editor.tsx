"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { CircleAlertIcon, FileDiffIcon, RefreshCwIcon, SaveIcon } from "lucide-react"
import { toast } from "sonner"

import { applyKubeEdit, reviewKubeEdit, type EditResult } from "@/app/(app)/kubernetes/edit-actions"
import { Button } from "@/components/ui/button"
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field"
import { Textarea } from "@/components/ui/textarea"
import { useI18n } from "@/lib/i18n/client"
import type { DiffResult } from "@/lib/kubernetes/diff"
import { cn } from "@/lib/utils"

/** Unified diff of the review step: removed lines in rust, added lines in sea. */
export function YamlDiff({ diff }: { diff: DiffResult }) {
  return (
    <div data-testid="yaml-diff" className="max-h-[60vh] overflow-auto rounded-lg border bg-muted/30 font-mono text-xs leading-relaxed">
      {diff.hunks.map((h, i) => (
        <div key={i} className="border-b last:border-b-0">
          <div className="bg-muted px-3 py-1 text-muted-foreground">
            @@ -{h.oldStart},{h.oldLines} +{h.newStart},{h.newLines} @@
          </div>
          {h.lines.map((l, j) => (
            <div
              key={j}
              data-diff={l.type}
              className={cn(
                "flex whitespace-pre",
                l.type === "add" && "bg-sea/12 text-sea",
                l.type === "remove" && "bg-rust/12 text-rust"
              )}
            >
              <span className="w-10 shrink-0 select-none pr-2 text-right text-muted-foreground/70">{l.oldNo ?? ""}</span>
              <span className="w-10 shrink-0 select-none pr-2 text-right text-muted-foreground/70">{l.newNo ?? ""}</span>
              <span className="w-4 shrink-0 select-none">{l.type === "add" ? "+" : l.type === "remove" ? "-" : " "}</span>
              <span>{l.text}</span>
            </div>
          ))}
        </div>
      ))}
    </div>
  )
}

/**
 * "Edit YAML" for one object: edit, review the server-side dry run as a
 * diff against the live object, then apply. The update carries the
 * resourceVersion the editor was loaded at, so concurrent changes surface
 * as a conflict. Remount it (key) with a new resourceVersion to start over.
 */
export function YamlEditor({
  environmentId,
  resource,
  kind,
  namespace,
  name,
  yaml,
  resourceVersion,
}: {
  environmentId: number
  resource: string
  kind: string
  namespace: string
  name: string
  yaml: string
  resourceVersion: string
}) {
  const { t, format, rich } = useI18n()
  const k = t.kubernetes.edit
  const uid = React.useId()
  const router = useRouter()
  const [text, setText] = React.useState(yaml)
  const [review, setReview] = React.useState<(EditResult & { text: string }) | null>(null)
  const [problem, setProblem] = React.useState<{ message: string; conflict: boolean } | null>(null)
  const [pending, startTransition] = React.useTransition()
  const [reloading, startReload] = React.useTransition()

  const input = { environmentId, resource, namespace, name, resourceVersion, yaml: text }
  const reviewed = review?.ok && review.text === text ? review : null

  function onReview() {
    setProblem(null)
    startTransition(async () => {
      const res = await reviewKubeEdit(input).catch(() => ({ error: t.common.errors.requestFailed }) as EditResult)
      if (res.error) {
        setReview(null)
        setProblem({ message: res.error, conflict: Boolean(res.conflict) })
        return
      }
      setReview({ ...res, text })
    })
  }

  function onApply() {
    setProblem(null)
    startTransition(async () => {
      const res = await applyKubeEdit(input).catch(() => ({ error: t.common.errors.requestFailed }) as EditResult)
      if (res.error) {
        setProblem({ message: res.error, conflict: Boolean(res.conflict) })
        if (res.conflict) setReview(null)
        return
      }
      // The action refreshes the page: it reloads the object and the editor restarts at the new version.
      toast.success(res.message ?? format(k.updated, { kind, name }))
    })
  }

  function onReload() {
    startReload(() => router.refresh())
  }

  return (
    <div className="flex flex-col gap-4 px-4 lg:px-6">
      {problem ? (
        <Card className="border-destructive/40" role="alert" data-testid={problem.conflict ? "edit-conflict" : "edit-error"}>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-destructive">
              <CircleAlertIcon className="size-4" />
              {problem.conflict ? k.conflictTitle : k.notApplied}
            </CardTitle>
            <CardDescription className="break-words">{problem.message}</CardDescription>
            {problem.conflict ? (
              <CardAction>
                <Button variant="outline" size="sm" onClick={onReload} disabled={reloading}>
                  <RefreshCwIcon data-icon="inline-start" className={reloading ? "animate-spin" : undefined} />
                  {k.loadLatest}
                </Button>
              </CardAction>
            ) : null}
          </CardHeader>
          {problem.conflict ? (
            <CardContent className="text-sm text-muted-foreground">
              {k.loadLatestHelp}
            </CardContent>
          ) : null}
        </Card>
      ) : null}

      <Field>
        <FieldLabel htmlFor={`${uid}-yaml`}>YAML</FieldLabel>
        <Textarea
          id={`${uid}-yaml`}
          value={text}
          onChange={(e) => setText(e.target.value)}
          className="max-h-[70vh] min-h-96 font-mono text-xs leading-relaxed md:text-xs"
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          wrap="off"
        />
        <FieldDescription>
          {rich(k.yamlHelp, { command: <code>kubectl replace</code>, version: resourceVersion })}
        </FieldDescription>
      </Field>

      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="outline" onClick={onReview} disabled={pending}>
          <FileDiffIcon data-icon="inline-start" />
          {pending && !reviewed ? k.checking : k.review}
        </Button>
        <Button type="button" onClick={onApply} disabled={pending || !reviewed || reviewed.unchanged}>
          <SaveIcon data-icon="inline-start" />
          {pending && reviewed ? k.applying : k.applyChanges}
        </Button>
        {text !== yaml ? (
          <Button
            type="button"
            variant="ghost"
            onClick={() => {
              setText(yaml)
              setReview(null)
              setProblem(null)
            }}
            disabled={pending}
          >
            {k.discard}
          </Button>
        ) : null}
      </div>

      {review?.ok && review.text !== text ? (
        <FieldError>{k.staleReview}</FieldError>
      ) : null}

      {reviewed ? (
        <Card>
          <CardHeader>
            <CardTitle>{k.changes}</CardTitle>
            <CardDescription>
              {reviewed.unchanged
                ? k.unchanged
                : format(reviewed.diff?.approximate ? k.diffSummaryApproximate : k.diffSummary, {
                    added: reviewed.diff?.added ?? 0,
                    removed: reviewed.diff?.removed ?? 0,
                  })}
            </CardDescription>
          </CardHeader>
          {reviewed.diff && !reviewed.unchanged ? (
            <CardContent>
              <YamlDiff diff={reviewed.diff} />
            </CardContent>
          ) : null}
        </Card>
      ) : null}
    </div>
  )
}
