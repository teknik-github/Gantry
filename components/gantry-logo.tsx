import { ContainerIcon } from "lucide-react"

import { cn } from "@/lib/utils"

export function GantryMark({ className }: { className?: string }) {
  return (
    <div
      className={cn(
        "flex size-6 items-center justify-center rounded-md bg-crane text-dock",
        className
      )}
    >
      <ContainerIcon className="size-4" />
    </div>
  )
}
