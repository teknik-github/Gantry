import { Suspense } from "react"
import { cookies } from "next/headers"
import { redirect } from "next/navigation"
import type { Metadata } from "next"

import { TwoFactorForm } from "@/components/two-factor-form"
import { Skeleton } from "@/components/ui/skeleton"
import { PENDING_2FA_COOKIE, verifyPending2fa } from "@/lib/server/auth/flow-tokens"
import { getI18n } from "@/lib/i18n/server"

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getI18n()).t.auth.titles.twoFactor }
}

export default function TwoFactorPage() {
  return (
    <Suspense fallback={<Skeleton className="h-64 w-full" />}>
      <TwoFactorGate />
    </Suspense>
  )
}

// Only reachable right after a correct password (the pending cookie).
async function TwoFactorGate() {
  const pending = await verifyPending2fa((await cookies()).get(PENDING_2FA_COOKIE)?.value)
  if (!pending) redirect("/login")
  return <TwoFactorForm />
}
