import type { Metadata } from "next"
import Link from "next/link"
import { notFound } from "next/navigation"
import { ArrowLeftIcon, TriangleAlertIcon } from "lucide-react"

import { FileBrowser } from "@/components/gantry/file-browser"
import { PageBody } from "@/components/gantry/page-body"
import { DockerUnavailable, Mono, StateBadge } from "@/components/gantry/ui"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { requireUser } from "@/lib/server/auth/dal"
import { getDocker, getPermissions } from "@/lib/server/environments"
import { filesLimits } from "@/lib/server/files/config"
import { HELPER_LABEL } from "@/lib/server/files/helper"
import { FilesError, inspectVolume } from "@/lib/server/files/service"
import { tryDocker } from "@/lib/server/views"

const VOLUME_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,254}$/

export async function generateMetadata({ params }: PageProps<"/volumes/[name]">): Promise<Metadata> {
  const { name } = await params
  return { title: `Volume ${decodeURIComponent(name)}` }
}

export default async function VolumePage({ params }: PageProps<"/volumes/[name]">) {
  await requireUser()
  const name = decodeURIComponent((await params).name)
  if (!VOLUME_NAME.test(name)) notFound()
  const can = await getPermissions()

  const result = await tryDocker(async () => {
    const api = await getDocker()
    let volume
    try {
      volume = await inspectVolume(api, name)
    } catch (err) {
      if (err instanceof FilesError && err.status === 404) return null
      throw err
    }
    const containers = await api.listContainers(true)
    return { volume, containers }
  })
  if (result.error !== undefined) {
    return (
      <PageBody>
        <DockerUnavailable message={result.error} />
      </PageBody>
    )
  }
  if (!result.data) notFound()

  const { volume, containers } = result.data
  // File browser helpers mount it too, briefly; they don't count.
  const usedBy = containers
    .filter((c) => !c.Labels?.[HELPER_LABEL])
    .flatMap((c) => {
      const mount = c.Mounts?.find((m) => m.Type === "volume" && m.Name === name)
      return mount ? [{ id: c.Id, name: c.Names[0]?.replace(/^\//, "") ?? c.Id.slice(0, 12), state: c.State, target: mount.Destination, rw: mount.RW !== false }] : []
    })
  const running = usedBy.filter((c) => c.state === "running")
  const writeWarning = usedBy.length
    ? `${name} is mounted by ${usedBy.map((c) => `${c.name} (${c.state})`).join(", ")}. ${
        running.length
          ? "Changing files that a running application uses can corrupt its data."
          : "The containers will see your changes when they start."
      } Continue?`
    : null

  return (
    <PageBody>
      <div className="grid gap-1 px-4 lg:px-6">
        <Button asChild variant="link" size="sm" className="h-auto w-fit p-0 text-muted-foreground">
          <Link href="/volumes">
            <ArrowLeftIcon data-icon="inline-start" />
            Volumes
          </Link>
        </Button>
        <h2 className="text-xl font-semibold tracking-tight">{volume.Name}</h2>
        <p className="text-sm text-muted-foreground">
          {volume.Driver} · <Mono>{volume.Mountpoint}</Mono>
        </p>
      </div>

      <div className="px-4 lg:px-6">
        <Card>
          <CardHeader>
            <CardTitle>Used by</CardTitle>
            <CardDescription>
              {usedBy.length ? `${usedBy.length} container(s) mount this volume.` : "No container mounts this volume."}
            </CardDescription>
          </CardHeader>
          {usedBy.length ? (
            <CardContent className="flex flex-col gap-2 text-sm" data-testid="volume-used-by">
              {running.length ? (
                <p className="flex items-center gap-1.5 text-amber-700 dark:text-amber-400">
                  <TriangleAlertIcon className="size-4" />
                  In use by a running container: be careful when changing files.
                </p>
              ) : null}
              {usedBy.map((c) => (
                <div key={c.id} className="flex flex-wrap items-center gap-2">
                  <Link href={`/containers/${c.id}`} className="font-medium underline-offset-4 hover:underline">
                    {c.name}
                  </Link>
                  <StateBadge state={c.state} />
                  <Mono className="text-muted-foreground">
                    {c.target} · {c.rw ? "read-write" : "read-only"}
                  </Mono>
                </div>
              ))}
            </CardContent>
          ) : null}
        </Card>
      </div>

      <div className="px-4 lg:px-6">
        {can.operate ? (
          <FileBrowser
            target={{ kind: "volume", name: volume.Name }}
            rootLabel={volume.Name}
            canWrite={can.manage}
            writeWarning={writeWarning}
            limits={filesLimits()}
          />
        ) : (
          <p className="text-sm text-muted-foreground" data-testid="files-hidden">
            Browsing files needs the operator role in this environment.
          </p>
        )}
      </div>
    </PageBody>
  )
}
