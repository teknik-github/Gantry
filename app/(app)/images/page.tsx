import type { Metadata } from "next"
import Link from "next/link"
import { HammerIcon } from "lucide-react"

import { ImageScanProvider, ImageScanSettings } from "@/components/gantry/image-scan-server"
import { ImagesTable, type ImageRow } from "@/components/gantry/images-table"
import { PageBody } from "@/components/gantry/page-body"
import { DockerUnavailable, PageHeader } from "@/components/gantry/ui"
import { Button } from "@/components/ui/button"
import { formatBytes, shortId, timeAgo } from "@/lib/format"
import { requireUser } from "@/lib/server/auth/dal"
import { getDocker, getPermissions } from "@/lib/server/environments"
import { tryDocker } from "@/lib/server/views"

export const metadata: Metadata = { title: "Images" }

export default async function ImagesPage() {
  await requireUser()
  const can = await getPermissions()
  const result = await tryDocker(async () => {
    const api = await getDocker()
    const [images, containers] = await Promise.all([api.listImages(), api.listContainers(true)])
    return { images, containers }
  })

  if (result.error !== undefined) {
    return (
      <PageBody>
        <PageHeader title="Images" />
        <DockerUnavailable message={result.error} />
      </PageBody>
    )
  }

  // /images/json reports Containers = -1 unless asked; count usage ourselves.
  const usage = new Map<string, number>()
  for (const c of result.data.containers) usage.set(c.ImageID, (usage.get(c.ImageID) ?? 0) + 1)

  const rows: ImageRow[] = result.data.images
    .map((i) => ({
      id: i.Id,
      shortId: shortId(i.Id),
      tags: (i.RepoTags ?? []).filter((t) => t !== "<none>:<none>"),
      size: i.Size,
      sizeLabel: formatBytes(i.Size),
      created: i.Created,
      createdLabel: timeAgo(i.Created),
      inUse: usage.get(i.Id) ?? 0,
    }))
    .sort((a, b) => b.created - a.created)

  const total = rows.reduce((a, r) => a + r.size, 0)

  return (
    <PageBody>
      <PageHeader
        title="Images"
        description={`${rows.length} image(s) using ${formatBytes(total)}`}
        actions={
          can.manage ? (
            <Button asChild size="sm" variant="outline">
              <Link href="/images/build">
                <HammerIcon data-icon="inline-start" />
                Build image
              </Link>
            </Button>
          ) : null
        }
      />
      {can.admin ? <ImageScanSettings /> : null}
      <ImageScanProvider>
        <ImagesTable data={rows} canManage={can.manage} canOperate={can.operate} />
      </ImageScanProvider>
    </PageBody>
  )
}
