import type { Metadata } from "next"
import Link from "next/link"
import { ArrowLeftIcon } from "lucide-react"

import { StackEditor } from "@/components/gantry/stack-editor"
import { DockerUnavailable, PageBody } from "@/components/gantry/ui"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { requireAdmin } from "@/lib/server/auth/dal"
import { getCurrentEnvironment } from "@/lib/server/environments"

export const metadata: Metadata = { title: "New stack" }

export default async function NewStackPage() {
  await requireAdmin()
  const env = await getCurrentEnvironment()

  return (
    <PageBody>
      <div className="grid gap-1 px-4 lg:px-6">
        <Button asChild variant="link" size="sm" className="h-auto w-fit p-0 text-muted-foreground">
          <Link href="/stacks">
            <ArrowLeftIcon data-icon="inline-start" />
            Stacks
          </Link>
        </Button>
        <h2 className="text-xl font-semibold tracking-tight">New stack</h2>
        {env ? (
          <p className="text-sm text-muted-foreground">
            Deployed with <code>docker compose</code> on <span className="font-medium text-foreground">{env.name}</span>.
          </p>
        ) : null}
      </div>
      {env ? (
        <div className="px-4 lg:px-6">
          <Card>
            <CardContent>
              <StackEditor />
            </CardContent>
          </Card>
        </div>
      ) : (
        <DockerUnavailable message="No Docker environment configured" />
      )}
    </PageBody>
  )
}
