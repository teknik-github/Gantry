import "server-only"

import Link from "next/link"

import { ImageScanSettingsCard, ScanStatus, ScanStatusProvider } from "@/components/gantry/image-scan-ui"
import { timeAgo } from "@/lib/format"
import { imageScanPath } from "@/lib/image-scan"
import { getCurrentEnvironment } from "@/lib/server/environments"
import { getImageScanSettings, lastImageScanRun, scanSummaries } from "@/lib/server/image-scans"
import { trivyImage } from "@/lib/server/trivy"

// Server parts of the scan UI, so the Images and container pages only add
// a line each.

/** Feeds the "Vulnerabilities" column of the Images table below it. */
export async function ImageScanProvider({ children }: { children: React.ReactNode }) {
  const env = await getCurrentEnvironment()
  const scans = env && env.type !== "kubernetes" ? await scanSummaries(env.id) : []
  return <ScanStatusProvider initial={scans}>{children}</ScanStatusProvider>
}

/** Administrators' settings card (daily scan, alert severity). */
export async function ImageScanSettings() {
  const [settings, lastRun] = await Promise.all([getImageScanSettings(), lastImageScanRun()])
  const now = new Date()
  return (
    <ImageScanSettingsCard
      enabled={settings.enabled}
      time={settings.time}
      minSeverity={settings.minSeverity}
      serverTime={now.toTimeString().slice(0, 5)}
      timeZone={Intl.DateTimeFormat().resolvedOptions().timeZone}
      scanner={trivyImage()}
      lastRun={
        lastRun
          ? `Last ${lastRun.trigger === "manual" ? "manual" : "scheduled"} run ${timeAgo(lastRun.at)} queued ${lastRun.queued} image(s)${
              lastRun.errors.length ? `; ${lastRun.errors.join("; ")}` : ""
            }.`
          : null
      }
    />
  )
}

/** Scan summary of a container's image (container page), linking to the findings. */
export async function ContainerImageScan({ imageId, name }: { imageId: string; name: string }) {
  const env = await getCurrentEnvironment()
  if (!env || !/^sha256:[a-f0-9]{64}$/.test(imageId)) return <span className="text-muted-foreground">—</span>
  const summary = (await scanSummaries(env.id)).find((s) => s.imageId === imageId)
  return (
    <span className="flex flex-wrap items-center gap-2" data-testid="container-image-scan">
      <ScanStatus summary={summary} imageId={imageId} name={name} />
      <Link href={imageScanPath(imageId)} className="text-xs text-muted-foreground underline-offset-4 hover:underline">
        {summary?.scannedAt ? `scanned ${timeAgo(summary.scannedAt)}` : "details"}
      </Link>
    </span>
  )
}
