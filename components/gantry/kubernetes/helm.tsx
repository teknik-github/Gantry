"use client"

import * as React from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { Trash2Icon } from "lucide-react"

import { uninstallHelmRelease } from "@/app/(app)/kubernetes/helm-actions"
import { columnHelperFor, DataTable, SortHeader } from "@/components/data-table"
import { ConfirmAction } from "@/components/gantry/confirm-button"
import { Age, KubeStatus } from "@/components/gantry/kubernetes/tables"
import { Mono } from "@/components/gantry/ui"
import { Button } from "@/components/ui/button"
import type { I18n } from "@/lib/i18n"
import { useI18n } from "@/lib/i18n/client"
import type { HelmReleaseRow } from "@/lib/server/kubernetes/helm"

function UninstallButton({
  environmentId,
  release,
  variant = "icon",
  onDone,
}: {
  environmentId: number
  release: Pick<HelmReleaseRow, "name" | "namespace">
  variant?: "icon" | "button"
  onDone?: () => void
}) {
  const { t, format } = useI18n()
  const k = t.kubernetes.helm
  return (
    <ConfirmAction
      title={format(k.uninstallTitle, { name: release.name })}
      description={format(k.uninstallDescription, { namespace: release.namespace, name: release.name })}
      confirmLabel={k.uninstall}
      onConfirm={async () => {
        const res = await uninstallHelmRelease({ environmentId, namespace: release.namespace, name: release.name })
        if (res.ok) onDone?.()
        return res
      }}
    >
      {variant === "icon" ? (
        <Button variant="ghost" size="icon" className="size-8 text-muted-foreground" aria-label={k.uninstall} title={k.uninstall}>
          <Trash2Icon />
        </Button>
      ) : (
        <Button variant="outline" size="sm">
          <Trash2Icon data-icon="inline-start" />
          {k.uninstall}
        </Button>
      )}
    </ConfirmAction>
  )
}

const helper = columnHelperFor<HelmReleaseRow>()

function columns({ t }: I18n, environmentId: number, canManage: boolean, showNamespace: boolean) {
  const k = t.kubernetes.helm
  return helper.columns([
    helper.accessor("name", {
      header: ({ column }) => <SortHeader column={column} title={k.release} />,
      cell: ({ row }) => (
        <Link
          href={`/kubernetes/helm/${encodeURIComponent(row.original.namespace)}/${encodeURIComponent(row.original.name)}`}
          className="font-medium hover:underline"
        >
          {row.original.name}
        </Link>
      ),
      enableHiding: false,
    }),
    ...(showNamespace
      ? [helper.accessor("namespace", { header: ({ column }) => <SortHeader column={column} title={t.kubernetes.common.namespace} /> })]
      : []),
    helper.accessor("chart", {
      header: ({ column }) => <SortHeader column={column} title={k.chart} />,
      cell: ({ row }) => (
        <Mono>
          {row.original.chart}
          {row.original.chartVersion ? `-${row.original.chartVersion}` : ""}
        </Mono>
      ),
    }),
    helper.accessor("appVersion", { header: k.appVersion, cell: ({ row }) => <Mono>{row.original.appVersion || "—"}</Mono> }),
    helper.accessor("status", {
      header: t.common.fields.status,
      cell: ({ row }) => (
        <span data-testid={`helm-status-${row.original.name}`}>
          <KubeStatus status={row.original.status} />
        </span>
      ),
    }),
    helper.accessor("revision", {
      header: k.revision,
      cell: ({ row }) => <span className="tabular-nums">{row.original.revision}</span>,
    }),
    helper.accessor("updated", {
      header: ({ column }) => <SortHeader column={column} title={t.common.fields.updated} />,
      cell: ({ row }) => <Age at={row.original.updated} />,
    }),
    helper.display({
      id: "actions",
      cell: ({ row }) =>
        canManage ? (
          <div className="flex justify-end">
            <UninstallButton environmentId={environmentId} release={row.original} />
          </div>
        ) : null,
      enableHiding: false,
    }),
  ])
}

export function HelmReleasesTable({
  data,
  environmentId,
  canManage,
  showNamespace,
}: {
  data: HelmReleaseRow[]
  environmentId: number
  canManage: boolean
  showNamespace: boolean
}) {
  const i18n = useI18n()
  const { t } = i18n
  const cols = React.useMemo(
    () => columns(i18n, environmentId, canManage, showNamespace),
    [i18n, environmentId, canManage, showNamespace]
  )
  return (
    <DataTable
      data={data}
      columns={cols}
      getRowId={(r) => r.id}
      searchText={(r) => `${r.name} ${r.namespace} ${r.chart} ${r.status}`}
      searchPlaceholder={t.kubernetes.helm.search}
      emptyMessage={t.kubernetes.helm.empty}
      columnLabels={
        i18n.locale === "en"
          ? undefined
          : {
              namespace: t.kubernetes.common.namespace,
              chart: t.kubernetes.helm.chart,
              appVersion: t.kubernetes.helm.appVersion,
              status: t.common.fields.status,
              revision: t.kubernetes.helm.revision,
              updated: t.common.fields.updated,
            }
      }
      pageSize={20}
    />
  )
}

/** Uninstall button of the release page; goes back to the list afterwards. */
export function HelmReleaseActions({ environmentId, namespace, name }: { environmentId: number; namespace: string; name: string }) {
  const router = useRouter()
  return (
    <UninstallButton
      environmentId={environmentId}
      release={{ namespace, name }}
      variant="button"
      onDone={() => router.push("/kubernetes/helm")}
    />
  )
}
