import Link from "next/link"
import { BoxIcon, HardDriveIcon, LayersIcon, NetworkIcon } from "lucide-react"

import { Badge } from "@/components/ui/badge"
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
  images: { total: number; size: string; dangling: number }
  volumes: { total: number }
  networks: { total: number; custom: number }
}

export function SectionCards({ summary }: { summary: DashboardSummary }) {
  const { containers, images, volumes, networks } = summary

  return (
    <div className="grid grid-cols-1 gap-4 px-4 *:data-[slot=card]:bg-gradient-to-t *:data-[slot=card]:from-primary/5 *:data-[slot=card]:to-card *:data-[slot=card]:shadow-xs lg:px-6 @xl/main:grid-cols-2 @5xl/main:grid-cols-4 dark:*:data-[slot=card]:bg-card">
      <Card className="@container/card">
        <CardHeader>
          <CardDescription>Containers</CardDescription>
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
        <CardFooter className="flex-col items-start gap-1.5 text-sm">
          <Link href="/containers" className="line-clamp-1 flex gap-2 font-medium hover:underline">
            Manage containers <BoxIcon className="size-4" />
          </Link>
          <div className="text-muted-foreground">
            {containers.stopped} stopped{containers.paused ? `, ${containers.paused} paused` : ""}
          </div>
        </CardFooter>
      </Card>
      <Card className="@container/card">
        <CardHeader>
          <CardDescription>Images</CardDescription>
          <CardTitle className="text-2xl font-semibold tabular-nums @[250px]/card:text-3xl">
            {images.total}
          </CardTitle>
          <CardAction>
            <Badge variant="outline">{images.size}</Badge>
          </CardAction>
        </CardHeader>
        <CardFooter className="flex-col items-start gap-1.5 text-sm">
          <Link href="/images" className="line-clamp-1 flex gap-2 font-medium hover:underline">
            Manage images <LayersIcon className="size-4" />
          </Link>
          <div className="text-muted-foreground">
            {images.dangling ? `${images.dangling} dangling, can be pruned` : "No dangling images"}
          </div>
        </CardFooter>
      </Card>
      <Card className="@container/card">
        <CardHeader>
          <CardDescription>Volumes</CardDescription>
          <CardTitle className="text-2xl font-semibold tabular-nums @[250px]/card:text-3xl">
            {volumes.total}
          </CardTitle>
        </CardHeader>
        <CardFooter className="flex-col items-start gap-1.5 text-sm">
          <Link href="/volumes" className="line-clamp-1 flex gap-2 font-medium hover:underline">
            Manage volumes <HardDriveIcon className="size-4" />
          </Link>
          <div className="text-muted-foreground">Persistent data stores</div>
        </CardFooter>
      </Card>
      <Card className="@container/card">
        <CardHeader>
          <CardDescription>Networks</CardDescription>
          <CardTitle className="text-2xl font-semibold tabular-nums @[250px]/card:text-3xl">
            {networks.total}
          </CardTitle>
          <CardAction>
            <Badge variant="outline">{networks.custom} custom</Badge>
          </CardAction>
        </CardHeader>
        <CardFooter className="flex-col items-start gap-1.5 text-sm">
          <Link href="/networks" className="line-clamp-1 flex gap-2 font-medium hover:underline">
            Manage networks <NetworkIcon className="size-4" />
          </Link>
          <div className="text-muted-foreground">Including built-in bridge, host, none</div>
        </CardFooter>
      </Card>
    </div>
  )
}
