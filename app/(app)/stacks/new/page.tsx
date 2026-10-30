import type { Metadata } from "next"
import Link from "next/link"
import { ArrowLeftIcon } from "lucide-react"

import { StackEditor } from "@/components/gantry/stack-editor"
import { GitStackForm } from "@/components/gantry/stack-git"
import { PageBody } from "@/components/gantry/page-body"
import { DockerUnavailable } from "@/components/gantry/ui"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { requirePermission } from "@/lib/server/action"
import { KUBERNETES_ENVIRONMENT } from "@/lib/messages"
import { getCurrentEnvironment } from "@/lib/server/environments"

export const metadata: Metadata = { title: "New stack" }

export default async function NewStackPage() {
  const user = await requirePermission("manage")
  // Git stacks store repository credentials: global administrators only.
  const canUseGit = user.role === "admin"
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
        {env && env.type !== "kubernetes" ? (
          <p className="text-sm text-muted-foreground">
            Deployed with <code>docker compose</code> on <span className="font-medium text-foreground">{env.name}</span>.
          </p>
        ) : null}
      </div>
      {env && env.type !== "kubernetes" ? (
        <div className="px-4 lg:px-6">
          <Tabs defaultValue="editor">
            <TabsList>
              <TabsTrigger value="editor">Web editor</TabsTrigger>
              {canUseGit ? <TabsTrigger value="git">Git repository</TabsTrigger> : null}
            </TabsList>
            <TabsContent value="editor">
              <Card>
                <CardContent>
                  <StackEditor />
                </CardContent>
              </Card>
            </TabsContent>
            {canUseGit ? (
              <TabsContent value="git">
                <Card>
                  <CardContent>
                    <GitStackForm />
                  </CardContent>
                </Card>
              </TabsContent>
            ) : null}
          </Tabs>
        </div>
      ) : (
        <DockerUnavailable message={env ? KUBERNETES_ENVIRONMENT : "No Docker environment configured"} />
      )}
    </PageBody>
  )
}
