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
  return (
    <ConfirmAction
      title={`Uninstall ${release.name}?`}
      description={`Runs helm uninstall: deletes every object of release ${release.namespace}/${release.name} and its history (uninstall hooks run; objects marked "helm.sh/resource-policy: keep" stay).`}
      confirmLabel="Uninstall"
      onConfirm={async () => {
        const res = await uninstallHelmRelease({ environmentId, namespace: release.namespace, name: release.name })
        if (res.ok) onDone?.()
        return res
      }}
    >
      {variant === "icon" ? (
        <Button variant="ghost" size="icon" className="size-8 text-muted-foreground" aria-label="Uninstall" title="Uninstall">
          <Trash2Icon />
        </Button>
      ) : (
        <Button variant="outline" size="sm">
          <Trash2Icon data-icon="inline-start" />
          Uninstall
        </Button>
      )}
    </ConfirmAction>
  )
}

const helper = columnHelperFor<HelmReleaseRow>()

function columns(environmentId: number, canManage: boolean, showNamespace: boolean) {
  return helper.columns([
    helper.accessor("name", {
      header: ({ column }) => <SortHeader column={column} title="Release" />,
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
      ? [helper.accessor("namespace", { header: ({ column }) => <SortHeader column={column} title="Namespace" /> })]
      : []),
    helper.accessor("chart", {
      header: ({ column }) => <SortHeader column={column} title="Chart" />,
      cell: ({ row }) => (
        <Mono>
          {row.original.chart}
          {row.original.chartVersion ? `-${row.original.chartVersion}` : ""}
        </Mono>
      ),
    }),
    helper.accessor("appVersion", { header: "App version", cell: ({ row }) => <Mono>{row.original.appVersion || "—"}</Mono> }),
    helper.accessor("status", {
      header: "Status",
      cell: ({ row }) => (
        <span data-testid={`helm-status-${row.original.name}`}>
          <KubeStatus status={row.original.status} />
        </span>
      ),
    }),
    helper.accessor("revision", {
      header: "Revision",
      cell: ({ row }) => <span className="tabular-nums">{row.original.revision}</span>,
    }),
    helper.accessor("updated", {
      header: ({ column }) => <SortHeader column={column} title="Updated" />,
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
  const cols = React.useMemo(() => columns(environmentId, canManage, showNamespace), [environmentId, canManage, showNamespace])
  return (
    <DataTable
      data={data}
      columns={cols}
      getRowId={(r) => r.id}
      searchText={(r) => `${r.name} ${r.namespace} ${r.chart} ${r.status}`}
      searchPlaceholder="Search releases…"
      emptyMessage="No Helm releases."
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
