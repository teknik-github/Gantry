import { Suspense } from "react"
import { redirect } from "next/navigation"
import type { Metadata } from "next"

import { LoginForm } from "@/components/login-form"
import { Skeleton } from "@/components/ui/skeleton"
import { hasAnyUser } from "@/lib/server/auth/dal"
import { getOidcConfig } from "@/lib/server/auth/oidc"

export const metadata: Metadata = { title: "Login" }

/** Messages for ?sso=<reason> after a single sign-on attempt. */
const SSO_MESSAGES: Record<string, string> = {
  not_linked: "This SSO account isn't linked to a Gantry user. Ask an administrator, or sign in with your password and link it on your Account page.",
  failed: "Single sign-on failed. Try again or ask an administrator to check the server logs.",
  denied: "Single sign-on was cancelled.",
  expired: "The single sign-on attempt expired. Try again.",
  unavailable: "Single sign-on is unavailable right now.",
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
  return (
    <LoginForm
      next={typeof next === "string" ? next : undefined}
      sso={Boolean(getOidcConfig())}
      ssoMessage={typeof sso === "string" ? SSO_MESSAGES[sso] : undefined}
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
