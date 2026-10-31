"use client"

import * as React from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { FileDownIcon, HistoryIcon, PackagePlusIcon, RefreshCwIcon, RocketIcon } from "lucide-react"
import { toast } from "sonner"

import {
  installHelmChart,
  listHelmCharts,
  listHelmChartVersions,
  loadHelmChartValues,
  rollbackHelmRelease,
  upgradeHelmRelease,
  type HelmOperationState,
} from "@/app/(app)/kubernetes/helm-actions"
import { HelmOperationLog } from "@/components/gantry/kubernetes/helm-operation-log"
import { Mono } from "@/components/gantry/ui"
import { Button } from "@/components/ui/button"
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import { useI18n } from "@/lib/i18n/client"
import { MAX_TIMEOUT_MINUTES, type ChartSource, type ChartVersion } from "@/lib/kubernetes/helm-charts"
import type { HelmOperationInfo } from "@/lib/server/kubernetes/helm-operations"

/** A chart repository as the forms see it (no credentials). */
export type RepoOption = { id: number; name: string; url: string; oci: boolean }

// ------------------------------------------------------------ chart picker

export type ChartChoice = {
  mode: "repo" | "oci"
  repoId: number | null
  chart: string
  /** Picked (repo) or typed (oci) version; empty = latest. */
  version: string
  ociRef: string
}

/** The source the server actions take, or null while incomplete. */
export function chartSourceOf(c: ChartChoice): ChartSource | null {
  if (c.mode === "oci") return c.ociRef.trim() ? { type: "oci", ref: c.ociRef.trim() } : null
  return c.repoId && c.chart.trim() ? { type: "repo", repoId: c.repoId, chart: c.chart.trim() } : null
}

type Loaded<T> = { key: string; data: T; error?: string }

/**
 * Chart source: a repository's chart and version (listed with helm search)
 * or an oci:// reference. Controlled; `onChange` gets partial updates.
 */
export function ChartPicker({
  environmentId,
  repos,
  value,
  onChange,
  versions,
}: {
  environmentId: number
  repos: RepoOption[]
  value: ChartChoice
  onChange: (patch: Partial<ChartChoice>) => void
  versions: { list: ChartVersion[]; loading: boolean; error?: string }
}) {
  const { t, format, rich } = useI18n()
  const k = t.kubernetes.charts
  const uid = React.useId()
  const repo = repos.find((r) => r.id === value.repoId) ?? null
  const chartsKey = repo && !repo.oci ? String(repo.id) : ""
  const [charts, setCharts] = React.useState<Loaded<ChartVersion[]> | null>(null)
  const [refreshing, setRefreshing] = React.useState(false)

  React.useEffect(() => {
    if (!chartsKey) return
    let cancelled = false
    listHelmCharts(environmentId, Number(chartsKey)).then(
      (res) => !cancelled && setCharts({ key: chartsKey, data: res.data ?? [], error: res.error }),
      () => !cancelled && setCharts({ key: chartsKey, data: [], error: k.loadChartsFailed })
    )
    return () => {
      cancelled = true
    }
  }, [environmentId, chartsKey, k])

  const chartList = charts?.key === chartsKey ? charts : null
  const chartsLoading = Boolean(chartsKey) && !chartList

  async function refresh() {
    if (!repo) return
    setRefreshing(true)
    const res = await listHelmCharts(environmentId, repo.id, true).catch(() => ({ error: k.loadChartsFailed, data: undefined }))
    setRefreshing(false)
    setCharts({ key: String(repo.id), data: res.data ?? [], error: res.error })
    if (!res.error) toast.success(format(k.indexDownloaded, { name: repo.name }))
  }

  return (
    <FieldGroup>
      <Field className="max-w-md">
        <FieldLabel htmlFor={`${uid}-mode`}>{k.source}</FieldLabel>
        <Select value={value.mode} onValueChange={(mode) => onChange({ mode: mode as ChartChoice["mode"] })}>
          <SelectTrigger id={`${uid}-mode`} className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="repo">{k.sourceRepo}</SelectItem>
            <SelectItem value="oci">{k.sourceOci}</SelectItem>
          </SelectContent>
        </Select>
      </Field>

      {value.mode === "repo" ? (
        repos.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {rich(k.noRepos, {
              link: (
                <Link href="/kubernetes/charts/repositories" className="underline">
                  {t.kubernetes.helm.chartRepositories}
                </Link>
              ),
            })}
          </p>
        ) : (
          <>
            <div className="flex flex-wrap items-end gap-3">
              <Field className="max-w-md flex-1">
                <FieldLabel htmlFor={`${uid}-repo`}>{k.repository}</FieldLabel>
                <Select
                  value={value.repoId ? String(value.repoId) : ""}
                  onValueChange={(id) => onChange({ repoId: Number(id), chart: "", version: "" })}
                >
                  <SelectTrigger id={`${uid}-repo`} className="w-full">
                    <SelectValue placeholder={k.pickRepository} />
                  </SelectTrigger>
                  <SelectContent>
                    {repos.map((r) => (
                      <SelectItem key={r.id} value={String(r.id)}>
                        {r.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
              {repo && !repo.oci ? (
                <Button type="button" variant="outline" onClick={refresh} disabled={refreshing}>
                  <RefreshCwIcon data-icon="inline-start" className={refreshing ? "animate-spin" : undefined} />
                  {k.refreshIndex}
                </Button>
              ) : null}
            </div>
            {repo ? (
              <Field className="max-w-md">
                <FieldLabel htmlFor={`${uid}-chart`}>{t.kubernetes.helm.chart}</FieldLabel>
                <Input
                  id={`${uid}-chart`}
                  list={repo.oci ? undefined : `${uid}-charts`}
                  value={value.chart}
                  onChange={(e) => onChange({ chart: e.target.value, version: "" })}
                  placeholder={repo.oci ? k.chartInRegistry : chartsLoading ? k.loadingCharts : k.typeOrPick}
                  autoComplete="off"
                  spellCheck={false}
                />
                <datalist id={`${uid}-charts`}>
                  {chartList?.data.map((c) => (
                    <option key={c.name} value={c.name}>
                      {c.version}
                      {c.description ? ` · ${c.description.slice(0, 80)}` : ""}
                    </option>
                  ))}
                </datalist>
                <FieldDescription>
                  {repo.oci
                    ? rich(k.installedFrom, { path: <Mono>{repo.url}/&lt;chart&gt;</Mono> })
                    : chartList
                      ? format(k.chartsIn, { count: chartList.data.length, name: repo.name })
                      : k.loadingIndex}
                </FieldDescription>
                {chartList?.error ? <FieldError>{chartList.error}</FieldError> : null}
              </Field>
            ) : null}
          </>
        )
      ) : (
        <Field className="max-w-2xl">
          <FieldLabel htmlFor={`${uid}-oci`}>{k.ociReference}</FieldLabel>
          <Input
            id={`${uid}-oci`}
            value={value.ociRef}
            onChange={(e) => onChange({ ociRef: e.target.value })}
            placeholder="oci://registry.example.com/charts/app"
            autoComplete="off"
            spellCheck={false}
          />
          <FieldDescription>{k.ociHelp}</FieldDescription>
        </Field>
      )}

      {value.mode === "oci" || repo?.oci ? (
        <Field className="max-w-xs">
          <FieldLabel htmlFor={`${uid}-version`}>{k.version}</FieldLabel>
          <Input
            id={`${uid}-version`}
            value={value.version}
            onChange={(e) => onChange({ version: e.target.value })}
            placeholder={k.latest}
            autoComplete="off"
            spellCheck={false}
          />
        </Field>
      ) : repo && value.chart ? (
        <Field className="max-w-xs">
          <FieldLabel htmlFor={`${uid}-version`}>{k.version}</FieldLabel>
          <Select value={value.version} onValueChange={(version) => onChange({ version })} disabled={!versions.list.length}>
            <SelectTrigger id={`${uid}-version`} className="w-full">
              <SelectValue placeholder={versions.loading ? k.loadingVersions : k.noVersions} />
            </SelectTrigger>
            <SelectContent>
              {versions.list.map((v) => (
                <SelectItem key={v.version} value={v.version}>
                  {v.version}
                  {v.appVersion ? ` (app ${v.appVersion})` : ""}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {versions.error ? <FieldError>{versions.error}</FieldError> : null}
        </Field>
      ) : null}
    </FieldGroup>
  )
}

/**
 * Versions of the picked repository chart. `resolve` maps the chosen
 * version to the one in effect: the newest when nothing (or a version the
 * chart doesn't have) is chosen.
 */
function useChartVersions(environmentId: number, repos: RepoOption[], choice: ChartChoice) {
  const { t } = useI18n()
  const loadFailed = t.kubernetes.charts.loadVersionsFailed
  const repo = choice.mode === "repo" ? repos.find((r) => r.id === choice.repoId) : undefined
  const listed = Boolean(repo && !repo.oci)
  const key = listed && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(choice.chart.trim()) ? `${repo!.id}/${choice.chart.trim()}` : ""
  const [loaded, setLoaded] = React.useState<Loaded<ChartVersion[]> | null>(null)

  React.useEffect(() => {
    if (!key) return
    let cancelled = false
    const timer = setTimeout(() => {
      const id = Number(key.split("/")[0])
      const chart = key.slice(key.indexOf("/") + 1)
      listHelmChartVersions(environmentId, id, chart).then(
        (res) => !cancelled && setLoaded({ key, data: res.data ?? [], error: res.error }),
        () => !cancelled && setLoaded({ key, data: [], error: loadFailed })
      )
    }, 300)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [environmentId, key, loadFailed])

  const current = loaded?.key === key ? loaded : null
  const list = current?.data ?? []
  return {
    list,
    loading: Boolean(key) && !current,
    error: current?.error,
    resolve: (version: string) => (!listed ? version : list.some((v) => v.version === version) ? version : (list[0]?.version ?? "")),
  }
}

// ------------------------------------------------------------------ options

export type ReleaseOptionsValue = { wait: boolean; atomic: boolean; timeoutMinutes: string }

function ReleaseOptions({
  value,
  onChange,
  showAtomic = true,
}: {
  value: ReleaseOptionsValue
  onChange: (patch: Partial<ReleaseOptionsValue>) => void
  showAtomic?: boolean
}) {
  const { t } = useI18n()
  const k = t.kubernetes.charts
  const uid = React.useId()
  return (
    <FieldGroup className="gap-3">
      <Field orientation="horizontal">
        <Switch id={`${uid}-wait`} checked={value.wait || value.atomic} disabled={value.atomic} onCheckedChange={(wait) => onChange({ wait })} />
        <FieldLabel htmlFor={`${uid}-wait`} className="font-normal">
          {k.wait}
        </FieldLabel>
      </Field>
      {showAtomic ? (
        <Field orientation="horizontal">
          <Switch id={`${uid}-atomic`} checked={value.atomic} onCheckedChange={(atomic) => onChange({ atomic })} />
          <FieldLabel htmlFor={`${uid}-atomic`} className="font-normal">
            {k.atomic}
          </FieldLabel>
        </Field>
      ) : null}
      <Field className="max-w-48">
        <FieldLabel htmlFor={`${uid}-timeout`}>{k.timeout}</FieldLabel>
        <Input
          id={`${uid}-timeout`}
          type="number"
          min={1}
          max={MAX_TIMEOUT_MINUTES}
          value={value.timeoutMinutes}
          onChange={(e) => onChange({ timeoutMinutes: e.target.value })}
        />
      </Field>
    </FieldGroup>
  )
}

const DEFAULT_OPTIONS: ReleaseOptionsValue = { wait: true, atomic: false, timeoutMinutes: "5" }

function ValuesEditor({
  id,
  value,
  onChange,
  description,
  error,
}: {
  id: string
  value: string
  onChange: (v: string) => void
  description: React.ReactNode
  error?: string
}) {
  const { t } = useI18n()
  return (
    <Field data-invalid={error ? true : undefined}>
      <FieldLabel htmlFor={id}>{t.kubernetes.helm.values}</FieldLabel>
      <Textarea
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="max-h-[60vh] min-h-72 font-mono text-xs leading-relaxed md:text-xs"
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        wrap="off"
        aria-invalid={error ? true : undefined}
      />
      <FieldDescription>{description}</FieldDescription>
      <FieldError>{error}</FieldError>
    </Field>
  )
}

function useOperation() {
  const { t } = useI18n()
  const [operation, setOperation] = React.useState<HelmOperationInfo | null>(null)
  const [running, setRunning] = React.useState(false)
  const [starting, startTransition] = React.useTransition()

  function start(fn: () => Promise<HelmOperationState>) {
    startTransition(async () => {
      let res: HelmOperationState
      try {
        res = await fn()
      } catch {
        toast.error(t.common.errors.requestFailed)
        return
      }
      if (res.error || !res.operation) {
        toast.error(res.error ?? t.kubernetes.charts.startFailed)
        return
      }
      setOperation(res.operation)
      setRunning(true)
    })
  }
  return { operation, busy: starting || running, start, finished: () => setRunning(false) }
}

// ------------------------------------------------------------------ install

/** Install a chart: source, version, release, namespace, values, options; then the live output. */
export function HelmInstallForm({
  environmentId,
  repos,
  namespaces,
  defaultNamespace,
}: {
  environmentId: number
  repos: RepoOption[]
  namespaces: string[]
  defaultNamespace: string
}) {
  const { t, format } = useI18n()
  const k = t.kubernetes.charts
  const uid = React.useId()
  const [choice, setChoice] = React.useState<ChartChoice>({
    mode: repos.length ? "repo" : "oci",
    repoId: repos[0]?.id ?? null,
    chart: "",
    version: "",
    ociRef: "",
  })
  const patchChoice = React.useCallback((patch: Partial<ChartChoice>) => setChoice((c) => ({ ...c, ...patch })), [])
  const versions = useChartVersions(environmentId, repos, choice)
  const picked = { ...choice, version: versions.resolve(choice.version) }
  const [release, setRelease] = React.useState("")
  const [namespace, setNamespace] = React.useState(defaultNamespace)
  const [createNamespace, setCreateNamespace] = React.useState(true)
  const [options, setOptions] = React.useState(DEFAULT_OPTIONS)
  const [values, setValues] = React.useState("")
  const [valuesError, setValuesError] = React.useState<string>()
  const [loadingValues, setLoadingValues] = React.useState(false)
  // Edited by hand: chart changes no longer replace the values.
  const dirty = React.useRef(false)
  const op = useOperation()

  const source = chartSourceOf(picked)

  async function fetchDefaults(src: ChartSource, version: string, isCancelled: () => boolean = () => false) {
    setLoadingValues(true)
    const res = await loadHelmChartValues(environmentId, src, version).catch(() => ({ error: k.loadValuesFailed, data: undefined }))
    setLoadingValues(false)
    if (isCancelled()) return
    if (res.error !== undefined) toast.error(res.error)
    else {
      setValues(res.data ?? "")
      setValuesError(undefined)
    }
  }
  const fetchRef = React.useRef(fetchDefaults)
  React.useEffect(() => {
    fetchRef.current = fetchDefaults
  })

  // Prefill the chart's defaults once a repository chart and version are picked.
  const autoKey = picked.mode === "repo" && picked.version && source ? JSON.stringify({ source, version: picked.version }) : ""
  React.useEffect(() => {
    if (!autoKey) return
    let cancelled = false
    const { source: src, version } = JSON.parse(autoKey) as { source: ChartSource; version: string }
    const timer = setTimeout(() => {
      if (!dirty.current) void fetchRef.current(src, version, () => cancelled || dirty.current)
    }, 0)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [autoKey])

  function loadDefaults() {
    if (!source) return
    dirty.current = false
    void fetchDefaults(source, picked.version)
  }

  function submit(e: React.FormEvent) {
    e.preventDefault()
    if (!source) {
      toast.error(k.pickChartFirst)
      return
    }
    setValuesError(undefined)
    op.start(async () => {
      const res = await installHelmChart({
        environmentId,
        namespace: namespace.trim(),
        release: release.trim(),
        source,
        version: picked.version.trim(),
        values,
        createNamespace,
        wait: options.wait,
        atomic: options.atomic,
        timeoutMinutes: Number(options.timeoutMinutes),
      })
      if (res.fieldErrors?.values) setValuesError(res.fieldErrors.values[0])
      return res
    })
  }

  return (
    <div className="flex flex-col gap-6 px-4 lg:px-6">
      <form onSubmit={submit} className="flex flex-col gap-5" aria-label={k.installForm}>
        <ChartPicker environmentId={environmentId} repos={repos} value={picked} onChange={patchChoice} versions={versions} />
        <FieldGroup>
          <div className="grid max-w-3xl gap-4 sm:grid-cols-2">
            <Field>
              <FieldLabel htmlFor={`${uid}-release`}>{k.releaseName}</FieldLabel>
              <Input
                id={`${uid}-release`}
                value={release}
                onChange={(e) => setRelease(e.target.value)}
                placeholder="my-app"
                autoComplete="off"
                spellCheck={false}
                required
              />
            </Field>
            <Field>
              <FieldLabel htmlFor={`${uid}-namespace`}>{t.kubernetes.common.namespace}</FieldLabel>
              <Input
                id={`${uid}-namespace`}
                list={`${uid}-namespaces`}
                value={namespace}
                onChange={(e) => setNamespace(e.target.value)}
                autoComplete="off"
                spellCheck={false}
                required
              />
              <datalist id={`${uid}-namespaces`}>
                {namespaces.map((ns) => (
                  <option key={ns} value={ns} />
                ))}
              </datalist>
            </Field>
          </div>
          <Field orientation="horizontal">
            <Switch id={`${uid}-create-ns`} checked={createNamespace} onCheckedChange={setCreateNamespace} />
            <FieldLabel htmlFor={`${uid}-create-ns`} className="font-normal">
              {k.createNamespace}
            </FieldLabel>
          </Field>

          <ValuesEditor
            id={`${uid}-values`}
            value={values}
            onChange={(v) => {
              setValues(v)
              dirty.current = true
            }}
            error={valuesError}
            description={
              <span className="flex flex-wrap items-center gap-2">
                <span>{k.valuesHelp}</span>
                <Button type="button" variant="outline" size="sm" onClick={loadDefaults} disabled={!source || loadingValues}>
                  <FileDownIcon data-icon="inline-start" />
                  {loadingValues ? t.common.status.loading : k.loadDefaults}
                </Button>
              </span>
            }
          />
          <ReleaseOptions value={options} onChange={(p) => setOptions((o) => ({ ...o, ...p }))} />
          <Field orientation="horizontal">
            <Button type="submit" disabled={op.busy || !source}>
              <PackagePlusIcon data-icon="inline-start" />
              {op.busy ? k.installing : k.install}
            </Button>
          </Field>
        </FieldGroup>
      </form>
      {op.operation ? (
        <div className="flex flex-col gap-3">
          <HelmOperationLog key={op.operation.id} operation={op.operation} onDone={op.finished} />
          {!op.busy ? (
            <Button variant="outline" size="sm" className="self-start" asChild>
              <Link href={`/kubernetes/helm/${encodeURIComponent(op.operation.namespace)}/${encodeURIComponent(op.operation.release)}`}>
                {format(k.openRelease, { name: op.operation.release })}
              </Link>
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

// ------------------------------------------------------------------ upgrade

/**
 * Upgrade of an existing release: chart source and version, and (for
 * administrators) the complete values, prefilled with the current ones.
 */
export function HelmUpgradeForm({
  environmentId,
  namespace,
  release,
  chart,
  repos,
  currentValues,
}: {
  environmentId: number
  namespace: string
  release: string
  /** The release's chart name, preselected. */
  chart: string
  repos: RepoOption[]
  /** Current user-supplied values (administrators); null = keep them unseen (--reset-then-reuse-values). */
  currentValues: string | null
}) {
  const { t } = useI18n()
  const k = t.kubernetes.charts
  const uid = React.useId()
  const router = useRouter()
  const [choice, setChoice] = React.useState<ChartChoice>({
    mode: repos.length ? "repo" : "oci",
    repoId: repos.find((r) => !r.oci)?.id ?? repos[0]?.id ?? null,
    chart,
    version: "",
    ociRef: "",
  })
  const patchChoice = React.useCallback((patch: Partial<ChartChoice>) => setChoice((c) => ({ ...c, ...patch })), [])
  const versions = useChartVersions(environmentId, repos, choice)
  const picked = { ...choice, version: versions.resolve(choice.version) }
  const [values, setValues] = React.useState(currentValues ?? "")
  const [options, setOptions] = React.useState(DEFAULT_OPTIONS)
  const op = useOperation()
  const source = chartSourceOf(picked)

  function submit(e: React.FormEvent) {
    e.preventDefault()
    if (!source) {
      toast.error(k.pickChartFirst)
      return
    }
    op.start(() =>
      upgradeHelmRelease({
        environmentId,
        namespace,
        release,
        source,
        version: picked.version.trim(),
        values: currentValues === null ? null : values,
        wait: options.wait,
        atomic: options.atomic,
        timeoutMinutes: Number(options.timeoutMinutes),
      })
    )
  }

  return (
    <div className="flex flex-col gap-5">
      <form onSubmit={submit} className="flex flex-col gap-5" aria-label={k.upgradeForm}>
        <ChartPicker environmentId={environmentId} repos={repos} value={picked} onChange={patchChoice} versions={versions} />
        {currentValues === null ? (
          <p className="text-sm text-muted-foreground">{k.valuesKept}</p>
        ) : (
          <ValuesEditor
            id={`${uid}-values`}
            value={values}
            onChange={setValues}
            description={k.upgradeValuesHelp}
          />
        )}
        <ReleaseOptions value={options} onChange={(p) => setOptions((o) => ({ ...o, ...p }))} />
        <Button type="submit" className="self-start" disabled={op.busy || !source}>
          <RocketIcon data-icon="inline-start" />
          {op.busy ? k.upgrading : t.kubernetes.helm.upgrade}
        </Button>
      </form>
      {op.operation ? (
        <HelmOperationLog
          key={op.operation.id}
          operation={op.operation}
          onDone={() => {
            op.finished()
            router.refresh()
          }}
        />
      ) : null}
    </div>
  )
}

// ----------------------------------------------------------------- rollback

export function HelmRollbackForm({
  environmentId,
  namespace,
  release,
  revisions,
}: {
  environmentId: number
  namespace: string
  release: string
  /** Earlier revisions to offer, newest first. */
  revisions: { revision: number; label: string }[]
}) {
  const { t } = useI18n()
  const k = t.kubernetes.charts
  const uid = React.useId()
  const router = useRouter()
  const [chosen, setRevision] = React.useState("")
  // The newest earlier revision unless another one was picked (the list changes after each operation).
  const revision = revisions.some((r) => String(r.revision) === chosen) ? chosen : String(revisions[0]?.revision ?? "")
  const [options, setOptions] = React.useState(DEFAULT_OPTIONS)
  const op = useOperation()

  if (!revisions.length) return <p className="text-sm text-muted-foreground">{k.noEarlierRevision}</p>

  function submit(e: React.FormEvent) {
    e.preventDefault()
    op.start(() =>
      rollbackHelmRelease({
        environmentId,
        namespace,
        release,
        revision: Number(revision),
        wait: options.wait,
        timeoutMinutes: Number(options.timeoutMinutes),
      })
    )
  }

  return (
    <div className="flex flex-col gap-5">
      <form onSubmit={submit} className="flex flex-col gap-5" aria-label={k.rollBackForm}>
        <Field className="max-w-md">
          <FieldLabel htmlFor={`${uid}-revision`}>{t.kubernetes.helm.revision}</FieldLabel>
          <Select value={revision} onValueChange={setRevision}>
            <SelectTrigger id={`${uid}-revision`} className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {revisions.map((r) => (
                <SelectItem key={r.revision} value={String(r.revision)}>
                  {r.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <FieldDescription>{k.rollBackHelp}</FieldDescription>
        </Field>
        <ReleaseOptions value={options} onChange={(p) => setOptions((o) => ({ ...o, ...p }))} showAtomic={false} />
        <Button type="submit" variant="outline" className="self-start" disabled={op.busy || !revision}>
          <HistoryIcon data-icon="inline-start" />
          {op.busy ? k.rollingBack : t.kubernetes.helm.rollBack}
        </Button>
      </form>
      {op.operation ? (
        <HelmOperationLog
          key={op.operation.id}
          operation={op.operation}
          onDone={() => {
            op.finished()
            router.refresh()
          }}
        />
      ) : null}
    </div>
  )
}
