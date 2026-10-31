import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"

// Client components (they translate themselves); re-exported for existing imports.
export { DockerUnavailable, NoEnvironment, WrongEnvironmentKind } from "@/components/gantry/environment-notices"

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

export function Mono({ className, ...props }: React.ComponentProps<"span">) {
  return <span className={cn("font-mono text-xs", className)} {...props} />
}
