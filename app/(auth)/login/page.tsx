import { Suspense } from "react"
import { redirect } from "next/navigation"
import type { Metadata } from "next"

import { LoginForm } from "@/components/login-form"
import { Skeleton } from "@/components/ui/skeleton"
import { hasAnyUser } from "@/lib/server/auth/dal"
import { getOidcConfig } from "@/lib/server/auth/oidc"
import { getI18n } from "@/lib/i18n/server"

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getI18n()).t.auth.titles.login }
}

export default function LoginPage({ searchParams }: PageProps<"/login">) {
  return (
    <Suspense fallback={<FormSkeleton />}>
      <LoginGate searchParams={searchParams} />
    </Suspense>
  )
}

async function LoginGate({ searchParams }: Pick<PageProps<"/login">, "searchParams">) {
  const { next, sso } = await searchParams
  // Fresh install: create the first administrator instead.
  if (!(await hasAnyUser())) redirect("/setup")
  const { t } = await getI18n()
  /** Messages for ?sso=<reason> after a single sign-on attempt. */
  const ssoMessages: Record<string, string> = t.auth.sso
  return (
    <LoginForm
      next={typeof next === "string" ? next : undefined}
      sso={Boolean(getOidcConfig())}
      ssoMessage={typeof sso === "string" && Object.hasOwn(ssoMessages, sso) ? ssoMessages[sso] : undefined}
      passwordForAdminsOnly={process.env.PASSWORD_LOGIN === "admins" && Boolean(getOidcConfig())}
    />
  )
}

function FormSkeleton() {
  return (
    <div className="flex flex-col gap-6">
      <Skeleton className="mx-auto h-8 w-48" />
      <Skeleton className="h-14 w-full" />
      <Skeleton className="h-14 w-full" />
      <Skeleton className="h-8 w-full" />
    </div>
  )
}
