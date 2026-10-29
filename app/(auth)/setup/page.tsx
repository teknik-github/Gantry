import { Suspense } from "react"
import { connection } from "next/server"
import { redirect } from "next/navigation"
import type { Metadata } from "next"

import { SetupForm } from "@/components/setup-form"
import { Skeleton } from "@/components/ui/skeleton"
import { hasAnyUser } from "@/lib/server/auth/dal"

export const metadata: Metadata = { title: "Setup" }

export default function SetupPage({ searchParams }: PageProps<"/setup">) {
  return (
    <Suspense fallback={<Skeleton className="h-80 w-full" />}>
      <SetupGate searchParams={searchParams} />
    </Suspense>
  )
}

async function SetupGate({ searchParams }: Pick<PageProps<"/setup">, "searchParams">) {
  await connection()
  if (await hasAnyUser()) redirect("/login")
  // Optional ?token=… prefill, e.g. from a link built from the server log.
  const { token } = await searchParams
  return <SetupForm token={typeof token === "string" ? token.slice(0, 128) : undefined} />
}
