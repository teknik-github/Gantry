import Link from "next/link"
import { ShieldAlertIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import type { SetupCheck } from "@/lib/server/setup-checks"

/** Dashboard card listing what an administrator still has to set up (hidden when nothing is left). */
export function SetupChecks({ checks }: { checks: SetupCheck[] }) {
  if (!checks.length) return null
  return (
    <div className="px-4 lg:px-6">
      <Card className="border-crane/50 bg-crane/5" data-testid="setup-checks">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <ShieldAlertIcon className="size-4 text-crane" />
            Setup checks
          </CardTitle>
          <CardDescription>
            {checks.length === 1 ? "One thing" : `${checks.length} things`} to sort out before relying on Gantry.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ul className="flex flex-col divide-y">
            {checks.map((c) => (
              <li key={c.id} className="flex flex-wrap items-center justify-between gap-3 py-3 first:pt-0 last:pb-0" data-check={c.id}>
                <div className="flex max-w-3xl flex-col gap-0.5">
                  <span className="text-sm font-medium">{c.title}</span>
                  <span className="text-sm text-muted-foreground">{c.detail}</span>
                </div>
                {c.href ? (
                  <Button size="sm" variant="outline" asChild>
                    <Link href={c.href}>{c.action ?? "Fix"}</Link>
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>
    </div>
  )
}
