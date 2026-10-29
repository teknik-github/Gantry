import type { Metadata } from "next"

import { ChangePasswordForm } from "@/components/gantry/account-form"
import { PageBody, PageHeader } from "@/components/gantry/ui"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { requireUser } from "@/lib/server/auth/dal"

export const metadata: Metadata = { title: "Account" }

export default async function AccountPage() {
  const user = await requireUser()

  return (
    <PageBody>
      <PageHeader
        title="Account"
        description={`Signed in as ${user.username} (${user.role === "admin" ? "administrator" : "standard user"})`}
      />
      <div className="px-4 lg:px-6">
        <Card>
          <CardHeader>
            <CardTitle>Change password</CardTitle>
            <CardDescription>Use at least 8 characters.</CardDescription>
          </CardHeader>
          <CardContent>
            <ChangePasswordForm />
          </CardContent>
        </Card>
      </div>
    </PageBody>
  )
}
