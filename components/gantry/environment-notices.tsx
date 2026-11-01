"use client"

import Link from "next/link"
import { CircleAlertIcon, ServerIcon, ServerOffIcon, ShipWheelIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Card, CardAction, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { useI18n } from "@/lib/i18n/client"
import { translateKnown } from "@/lib/i18n/known-messages"
import { KUBERNETES_ENVIRONMENT, NO_ENVIRONMENT_ASSIGNED } from "@/lib/messages"

export function DockerUnavailable({ message }: { message: string }) {
  const i18n = useI18n()
  const text = i18n.t.common.environment
  if (message === NO_ENVIRONMENT_ASSIGNED) return <NoEnvironment />
  if (message === KUBERNETES_ENVIRONMENT) return <WrongEnvironmentKind kind="kubernetes" />
  return (
    <div className="px-4 lg:px-6">
      <Card className="border-destructive/40">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-destructive">
            <CircleAlertIcon className="size-4" />
            {text.dockerUnreachable}
          </CardTitle>
          <CardDescription>
            {i18n.format(text.dockerUnreachableHelp, { message: translateKnown(i18n, message) })}
          </CardDescription>
        </CardHeader>
      </Card>
    </div>
  )
}

/** Empty state for a standard user who has not been given any environment. */
export function NoEnvironment() {
  const { t } = useI18n()
  return (
    <div className="px-4 lg:px-6">
      <Card data-testid="no-environment">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <ServerOffIcon className="size-4 text-muted-foreground" />
            {t.common.environment.noneAssigned}
          </CardTitle>
          <CardDescription>{t.common.environment.noEnvironmentHelp}</CardDescription>
        </CardHeader>
      </Card>
    </div>
  )
}

/**
 * Shown by Docker pages while a Kubernetes environment is selected
 * (kind="kubernetes"), and by Kubernetes pages for a Docker one.
 */
export function WrongEnvironmentKind({ kind }: { kind: "kubernetes" | "docker" }) {
  const { t } = useI18n()
  const text = t.common.environment
  const kubernetes = kind === "kubernetes"
  return (
    <div className="px-4 lg:px-6">
      <Card data-testid="wrong-environment-kind">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            {kubernetes ? (
              <ShipWheelIcon className="size-4 text-muted-foreground" />
            ) : (
              <ServerIcon className="size-4 text-muted-foreground" />
            )}
            {kubernetes ? text.isKubernetes : text.isDocker}
          </CardTitle>
          <CardDescription>{kubernetes ? text.dockerPageOnKubernetes : text.kubernetesPageOnDocker}</CardDescription>
          <CardAction>
            <Button size="sm" variant="outline" asChild>
              <Link href={kubernetes ? "/kubernetes" : "/dashboard"}>
                {kubernetes ? text.kubernetesOverview : text.dashboard}
              </Link>
            </Button>
          </CardAction>
        </CardHeader>
      </Card>
    </div>
  )
}
