import Link from "next/link"
import { BoxIcon, HardDriveIcon, LayersIcon, NetworkIcon } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Skeleton } from "@/components/ui/skeleton"
import {
  Card,
  CardAction,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { getI18n } from "@/lib/i18n/server"

export type DashboardSummary = {
  containers: { total: number; running: number; stopped: number; paused: number }
  volumes: { total: number }
  networks: { total: number; custom: number }
}

/**
 * The four summary cards. The images card is passed in (usually under
 * Suspense): listing images can take seconds with the containerd store.
 */
export async function SectionCards({ summary, images }: { summary: DashboardSummary; images: React.ReactNode }) {
  const { containers, volumes, networks } = summary
  const { t, format } = await getI18n()
  const text = t.dashboard.cards

  return (
    <div className="grid grid-cols-1 gap-4 px-4 *:data-[slot=card]:relative *:data-[slot=card]:overflow-hidden *:data-[slot=card]:shadow-xs lg:px-6 @xl/main:grid-cols-2 @5xl/main:grid-cols-4">
      <Card className="@container/card">
        <ContainerStripe tone="harbor" />
        <CardHeader>
          <CardDescription>
          <Kind tone="harbor" icon={<BoxIcon />}>{text.containers}</Kind>
        </CardDescription>
          <CardTitle className="text-2xl font-semibold tabular-nums @[250px]/card:text-3xl">
            {containers.total}
          </CardTitle>
          <CardAction>
            <Badge variant="outline">
              <span className="size-2 rounded-full bg-emerald-500" />
              {format(text.running, { count: containers.running })}
            </Badge>
          </CardAction>
        </CardHeader>
        <CardFooter className="flex-1 flex-col items-start gap-1.5 text-sm">
          <Link href="/containers" className="line-clamp-1 flex gap-2 font-medium hover:underline">
            {text.manageContainers} <BoxIcon className="size-4" />
          </Link>
          <div className="text-muted-foreground">
            {containers.paused
              ? format(text.stoppedPaused, { stopped: containers.stopped, paused: containers.paused })
              : format(text.stopped, { stopped: containers.stopped })}
          </div>
        </CardFooter>
      </Card>
      {images}
      <Card className="@container/card">
        <ContainerStripe tone="rust" />
        <CardHeader>
          <CardDescription>
          <Kind tone="rust" icon={<HardDriveIcon />}>{text.volumes}</Kind>
        </CardDescription>
          <CardTitle className="text-2xl font-semibold tabular-nums @[250px]/card:text-3xl">
            {volumes.total}
          </CardTitle>
        </CardHeader>
        <CardFooter className="flex-1 flex-col items-start gap-1.5 text-sm">
          <Link href="/volumes" className="line-clamp-1 flex gap-2 font-medium hover:underline">
            {text.manageVolumes} <HardDriveIcon className="size-4" />
          </Link>
          <div className="text-muted-foreground">{text.volumesHint}</div>
        </CardFooter>
      </Card>
      <Card className="@container/card">
        <ContainerStripe tone="sea" />
        <CardHeader>
          <CardDescription>
          <Kind tone="sea" icon={<NetworkIcon />}>{text.networks}</Kind>
        </CardDescription>
          <CardTitle className="text-2xl font-semibold tabular-nums @[250px]/card:text-3xl">
            {networks.total}
          </CardTitle>
          <CardAction>
            <Badge variant="outline">{format(text.custom, { count: networks.custom })}</Badge>
          </CardAction>
        </CardHeader>
        <CardFooter className="flex-1 flex-col items-start gap-1.5 text-sm">
          <Link href="/networks" className="line-clamp-1 flex gap-2 font-medium hover:underline">
            {text.manageNetworks} <NetworkIcon className="size-4" />
          </Link>
          <div className="text-muted-foreground">{text.networksHint}</div>
        </CardFooter>
      </Card>
    </div>
  )
}

export async function ImagesCard({ images }: { images: { total: number; size: string; dangling: number } | null }) {
  const { t, format } = await getI18n()
  const text = t.dashboard.cards
  return (
    <Card className="@container/card">
      <ContainerStripe tone="steel" />
      <CardHeader>
        <CardDescription>
          <Kind tone="steel" icon={<LayersIcon />}>{text.images}</Kind>
        </CardDescription>
        <CardTitle className="text-2xl font-semibold tabular-nums @[250px]/card:text-3xl">
          {images ? images.total : "—"}
        </CardTitle>
        {images ? (
          <CardAction>
            <Badge variant="outline">{images.size}</Badge>
          </CardAction>
        ) : null}
      </CardHeader>
      <CardFooter className="flex-1 flex-col items-start gap-1.5 text-sm">
        <Link href="/images" className="line-clamp-1 flex gap-2 font-medium hover:underline">
          {text.manageImages} <LayersIcon className="size-4" />
        </Link>
        <div className="text-muted-foreground">
          {!images
            ? text.imagesFailed
            : images.dangling
              ? format(text.dangling, { count: images.dangling })
              : text.noDangling}
        </div>
      </CardFooter>
    </Card>
  )
}

export async function ImagesCardSkeleton() {
  const { t } = await getI18n()
  return (
    <Card className="@container/card" aria-busy="true">
      <ContainerStripe tone="steel" />
      <CardHeader>
        <CardDescription>
          <Kind tone="steel" icon={<LayersIcon />}>{t.dashboard.cards.images}</Kind>
        </CardDescription>
        <Skeleton className="h-8 w-16" />
      </CardHeader>
      <CardFooter className="flex-1 flex-col items-start gap-2 text-sm">
        <Skeleton className="h-4 w-28" />
        <Skeleton className="h-4 w-40" />
      </CardFooter>
    </Card>
  )
}

type Tone = "harbor" | "steel" | "rust" | "sea"

const TONE_TEXT: Record<Tone, string> = {
  harbor: "bg-harbor/12 text-harbor",
  steel: "bg-steel/12 text-steel",
  rust: "bg-rust/12 text-rust",
  sea: "bg-sea/12 text-sea",
}

/** Card label with its resource colour. */
function Kind({ tone, icon, children }: { tone: Tone; icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <span className="flex items-center gap-2">
      <span className={`flex size-6 items-center justify-center rounded-md [&_svg]:size-3.5 ${TONE_TEXT[tone]}`}>{icon}</span>
      {children}
    </span>
  )
}

/** Top edge drawn like the corrugated wall of a shipping container. */
function ContainerStripe({ tone }: { tone: Tone }) {
  return (
    <span
      aria-hidden
      className="absolute inset-x-0 top-0 h-1"
      style={{
        background: `repeating-linear-gradient(90deg, var(--${tone}) 0 9px, color-mix(in oklch, var(--${tone}) 70%, black) 9px 11px)`,
      }}
    />
  )
}
