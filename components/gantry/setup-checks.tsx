import Link from "next/link"
import { ShieldAlertIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { getI18n } from "@/lib/i18n/server"
import type { SetupCheck, SetupCheckId } from "@/lib/server/setup-checks"

// Where each check's texts are in t.dashboard.setupChecks.
const TEXT_KEYS = {
  https: "https",
  cookie: "cookie",
  "trust-proxy": "trustProxy",
  backups: "backups",
  "2fa": "twoFactor",
  notifications: "notifications",
} as const satisfies Record<SetupCheckId, string>

/** Dashboard card listing what an administrator still has to set up (hidden when nothing is left). */
export async function SetupChecks({ checks }: { checks: SetupCheck[] }) {
  if (!checks.length) return null
  const i18n = await getI18n()
  const text = i18n.t.dashboard.setupChecks
  return (
    <div className="px-4 lg:px-6">
      <Card className="border-crane/50 bg-crane/5" data-testid="setup-checks">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <ShieldAlertIcon className="size-4 text-crane" />
            {text.title}
          </CardTitle>
          <CardDescription>{i18n.plural(text.summary, checks.length)}</CardDescription>
        </CardHeader>
        <CardContent>
          <ul className="flex flex-col divide-y">
            {checks.map((c) => {
              const check = text[TEXT_KEYS[c.id]]
              return (
                <li key={c.id} className="flex flex-wrap items-center justify-between gap-3 py-3 first:pt-0 last:pb-0" data-check={c.id}>
                  <div className="flex max-w-3xl flex-col gap-0.5">
                    <span className="text-sm font-medium">{check.title}</span>
                    <span className="text-sm text-muted-foreground">{check.detail}</span>
                  </div>
                  {c.href ? (
                    <Button size="sm" variant="outline" asChild>
                      <Link href={c.href}>{"action" in check ? check.action : text.fix}</Link>
                    </Button>
                  ) : null}
                </li>
              )
            })}
          </ul>
        </CardContent>
      </Card>
    </div>
  )
}
