import type { Metadata } from "next"
import Link from "next/link"
import { HammerIcon } from "lucide-react"

import { ImageScanProvider, ImageScanSettings } from "@/components/gantry/image-scan-server"
import { ImagesTable, type ImageRow } from "@/components/gantry/images-table"
import { PageBody } from "@/components/gantry/page-body"
import { DockerUnavailable, PageHeader } from "@/components/gantry/ui"
import { Button } from "@/components/ui/button"
import { shortId } from "@/lib/format"
import { getI18n } from "@/lib/i18n/server"
import { requireUser } from "@/lib/server/auth/dal"
import { getDocker, getPermissions } from "@/lib/server/environments"
import { tryDocker } from "@/lib/server/views"

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getI18n()).t.nav.pages.images }
}

export default async function ImagesPage() {
  await requireUser()
  const { t, format, formatBytes, timeAgo } = await getI18n()
  const can = await getPermissions()
  const result = await tryDocker(async () => {
    const api = await getDocker()
    const [images, containers] = await Promise.all([api.listImages(), api.listContainers(true)])
    return { images, containers }
  })

  if (result.error !== undefined) {
    return (
      <PageBody>
        <PageHeader title={t.nav.pages.images} />
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
      tags: (i.RepoTags ?? []).filter((tag) => tag !== "<none>:<none>"),
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
        title={t.nav.pages.images}
        description={format(t.images.count, { count: rows.length, size: formatBytes(total) })}
        actions={
          can.manage ? (
            <Button asChild size="sm" variant="outline">
              <Link href="/images/build">
                <HammerIcon data-icon="inline-start" />
                {t.images.buildImage}
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
