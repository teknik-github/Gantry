import { Suspense } from "react"
import { connection } from "next/server"
import { redirect } from "next/navigation"
import type { Metadata } from "next"

import { SetupForm } from "@/components/setup-form"
import { Skeleton } from "@/components/ui/skeleton"
import { hasAnyUser } from "@/lib/server/auth/dal"

export const metadata: Metadata = { title: "Setup" }

export default function SetupPage() {
  return (
    <Suspense fallback={<Skeleton className="h-80 w-full" />}>
      <SetupGate />
    </Suspense>
  )
}

async function SetupGate() {
  await connection()
  if (await hasAnyUser()) redirect("/login")
  return <SetupForm />
}
