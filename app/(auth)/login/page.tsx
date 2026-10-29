import { Suspense } from "react"
import { redirect } from "next/navigation"
import type { Metadata } from "next"

import { LoginForm } from "@/components/login-form"
import { Skeleton } from "@/components/ui/skeleton"
import { hasAnyUser } from "@/lib/server/auth/dal"

export const metadata: Metadata = { title: "Login" }

export default function LoginPage({ searchParams }: PageProps<"/login">) {
  return (
    <Suspense fallback={<FormSkeleton />}>
      <LoginGate searchParams={searchParams} />
    </Suspense>
  )
}

async function LoginGate({ searchParams }: Pick<PageProps<"/login">, "searchParams">) {
  const { next } = await searchParams
  // Fresh install: create the first administrator instead.
  if (!(await hasAnyUser())) redirect("/setup")
  return <LoginForm next={typeof next === "string" ? next : undefined} />
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
