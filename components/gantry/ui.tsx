import { CircleAlertIcon, ServerOffIcon } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { NO_ENVIRONMENT_ASSIGNED } from "@/lib/messages"
import { cn } from "@/lib/utils"

export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string
  description?: React.ReactNode
  actions?: React.ReactNode
}) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-3 px-4 lg:px-6">
      <div className="grid gap-1">
        <h2 className="text-xl font-semibold tracking-tight">{title}</h2>
        {description ? <p className="text-sm text-muted-foreground">{description}</p> : null}
      </div>
      {actions ? <div className="flex items-center gap-2">{actions}</div> : null}
    </div>
  )
}

export function PageBody({ children }: { children: React.ReactNode }) {
  return <div className="flex flex-col gap-4 py-4 md:gap-6 md:py-6">{children}</div>
}

export function DockerUnavailable({ message }: { message: string }) {
  if (message === NO_ENVIRONMENT_ASSIGNED) return <NoEnvironment />
  return (
    <div className="px-4 lg:px-6">
      <Card className="border-destructive/40">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-destructive">
            <CircleAlertIcon className="size-4" />
            Docker is unreachable
          </CardTitle>
          <CardDescription>
            {message}. Check that the Docker socket is mounted (or the TCP endpoint is reachable) and
            that Gantry has permission to access it, or switch to another environment.
          </CardDescription>
        </CardHeader>
      </Card>
    </div>
  )
}

/** Empty state for a standard user who has not been given any environment. */
export function NoEnvironment() {
  return (
    <div className="px-4 lg:px-6">
      <Card data-testid="no-environment">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <ServerOffIcon className="size-4 text-muted-foreground" />
            {NO_ENVIRONMENT_ASSIGNED}
          </CardTitle>
          <CardDescription>
            Your account has no access to a Docker environment yet. An administrator can grant it on the Users page.
          </CardDescription>
        </CardHeader>
      </Card>
    </div>
  )
}

const STATE_STYLES: Record<string, string> = {
  running: "bg-emerald-500",
  restarting: "bg-amber-500",
  paused: "bg-sky-500",
  created: "bg-muted-foreground",
  exited: "bg-red-500",
  dead: "bg-red-700",
  removing: "bg-amber-500",
}

export function StateBadge({ state }: { state: string }) {
  return (
    <Badge variant="outline" className="gap-1.5 px-1.5 text-muted-foreground capitalize">
      <span className={cn("size-2 rounded-full", STATE_STYLES[state] ?? "bg-muted-foreground")} />
      {state}
    </Badge>
  )
}

export function Mono({ children, className }: { children: React.ReactNode; className?: string }) {
  return <span className={cn("font-mono text-xs", className)}>{children}</span>
}
