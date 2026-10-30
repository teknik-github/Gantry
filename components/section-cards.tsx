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

export type DashboardSummary = {
  containers: { total: number; running: number; stopped: number; paused: number }
  volumes: { total: number }
  networks: { total: number; custom: number }
}

/**
 * The four summary cards. The images card is passed in (usually under
 * Suspense): listing images can take seconds with the containerd store.
 */
export function SectionCards({ summary, images }: { summary: DashboardSummary; images: React.ReactNode }) {
  const { containers, volumes, networks } = summary

  return (
    <div className="grid grid-cols-1 gap-4 px-4 *:data-[slot=card]:relative *:data-[slot=card]:overflow-hidden *:data-[slot=card]:shadow-xs lg:px-6 @xl/main:grid-cols-2 @5xl/main:grid-cols-4">
      <Card className="@container/card">
        <ContainerStripe tone="harbor" />
        <CardHeader>
          <CardDescription>
          <Kind tone="harbor" icon={<BoxIcon />}>Containers</Kind>
        </CardDescription>
          <CardTitle className="text-2xl font-semibold tabular-nums @[250px]/card:text-3xl">
            {containers.total}
          </CardTitle>
          <CardAction>
            <Badge variant="outline">
              <span className="size-2 rounded-full bg-emerald-500" />
              {containers.running} running
            </Badge>
          </CardAction>
        </CardHeader>
        <CardFooter className="flex-1 flex-col items-start gap-1.5 text-sm">
          <Link href="/containers" className="line-clamp-1 flex gap-2 font-medium hover:underline">
            Manage containers <BoxIcon className="size-4" />
          </Link>
          <div className="text-muted-foreground">
            {containers.stopped} stopped{containers.paused ? `, ${containers.paused} paused` : ""}
          </div>
        </CardFooter>
      </Card>
      {images}
      <Card className="@container/card">
        <ContainerStripe tone="rust" />
        <CardHeader>
          <CardDescription>
          <Kind tone="rust" icon={<HardDriveIcon />}>Volumes</Kind>
        </CardDescription>
          <CardTitle className="text-2xl font-semibold tabular-nums @[250px]/card:text-3xl">
            {volumes.total}
          </CardTitle>
        </CardHeader>
        <CardFooter className="flex-1 flex-col items-start gap-1.5 text-sm">
          <Link href="/volumes" className="line-clamp-1 flex gap-2 font-medium hover:underline">
            Manage volumes <HardDriveIcon className="size-4" />
          </Link>
          <div className="text-muted-foreground">Persistent data stores</div>
        </CardFooter>
      </Card>
      <Card className="@container/card">
        <ContainerStripe tone="sea" />
        <CardHeader>
          <CardDescription>
          <Kind tone="sea" icon={<NetworkIcon />}>Networks</Kind>
        </CardDescription>
          <CardTitle className="text-2xl font-semibold tabular-nums @[250px]/card:text-3xl">
            {networks.total}
          </CardTitle>
          <CardAction>
            <Badge variant="outline">{networks.custom} custom</Badge>
          </CardAction>
        </CardHeader>
        <CardFooter className="flex-1 flex-col items-start gap-1.5 text-sm">
          <Link href="/networks" className="line-clamp-1 flex gap-2 font-medium hover:underline">
            Manage networks <NetworkIcon className="size-4" />
          </Link>
          <div className="text-muted-foreground">Including built-in bridge, host, none</div>
        </CardFooter>
      </Card>
    </div>
  )
}

export function ImagesCard({ images }: { images: { total: number; size: string; dangling: number } | null }) {
  return (
    <Card className="@container/card">
      <ContainerStripe tone="steel" />
      <CardHeader>
        <CardDescription>
          <Kind tone="steel" icon={<LayersIcon />}>Images</Kind>
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
          Manage images <LayersIcon className="size-4" />
        </Link>
        <div className="text-muted-foreground">
          {!images
            ? "Couldn't list images"
            : images.dangling
              ? `${images.dangling} dangling, can be pruned`
              : "No dangling images"}
        </div>
      </CardFooter>
    </Card>
  )
}

export function ImagesCardSkeleton() {
  return (
    <Card className="@container/card" aria-busy="true">
      <ContainerStripe tone="steel" />
      <CardHeader>
        <CardDescription>
          <Kind tone="steel" icon={<LayersIcon />}>Images</Kind>
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
