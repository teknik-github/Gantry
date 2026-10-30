import type { Metadata } from "next"

import { ChangePasswordForm } from "@/components/gantry/account-form"
import { ApiTokensCard, LinkSsoButton, TwoFactorCard } from "@/components/gantry/account-security"
import { PageBody } from "@/components/gantry/page-body"
import { Mono, PageHeader } from "@/components/gantry/ui"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { formatDate, timeAgo } from "@/lib/format"
import { listApiTokens } from "@/lib/server/auth/api-tokens"
import { requireUser } from "@/lib/server/auth/dal"
import { getOidcConfig, NO_PASSWORD } from "@/lib/server/auth/oidc"
import { twoFactorStatus } from "@/lib/server/auth/two-factor"
import { getDb } from "@/lib/server/db"

export const metadata: Metadata = { title: "Account" }

const SSO_MESSAGES: Record<string, string> = {
  linked: "Your account is now linked to single sign-on.",
  taken: "That SSO identity is already linked to another Gantry user.",
  failed: "Linking failed. Try again or ask an administrator to check the server logs.",
  denied: "Linking was cancelled.",
  expired: "The linking attempt expired. Try again.",
}

export default async function AccountPage({ searchParams }: PageProps<"/account">) {
  const user = await requireUser()
  const db = await getDb()
  const [row, twoFactor, tokens, { sso }] = await Promise.all([
    db.selectFrom("users").select(["password_hash", "oidc_issuer"]).where("id", "=", user.id).executeTakeFirstOrThrow(),
    twoFactorStatus(db, user.id),
    listApiTokens(db, user.id),
    searchParams,
  ])
  const oidc = getOidcConfig()
  // SSO-only accounts have no password to change or to protect with a second factor.
  const hasPassword = row.password_hash !== NO_PASSWORD
  const now = new Date().getTime()

  return (
    <PageBody>
      <PageHeader
        title="Account"
        description={`Signed in as ${user.username} (${user.role === "admin" ? "administrator" : "standard user"})`}
      />
      <div className="grid gap-4 px-4 lg:px-6">
        {typeof sso === "string" && SSO_MESSAGES[sso] ? (
          <p role="status" className="rounded-md border p-3 text-sm" data-testid="sso-message">
            {SSO_MESSAGES[sso]}
          </p>
        ) : null}
        {hasPassword ? (
          <Card>
            <CardHeader>
              <CardTitle>Change password</CardTitle>
              <CardDescription>Use at least 8 characters. Your other sessions are signed out.</CardDescription>
            </CardHeader>
            <CardContent>
              <ChangePasswordForm />
            </CardContent>
          </Card>
        ) : null}
        {hasPassword ? (
          <Card>
            <CardHeader>
              <CardTitle>Two-factor authentication</CardTitle>
              <CardDescription>
                Ask for a code from an authenticator app (TOTP) after your password. Single sign-on logins use your
                identity provider&apos;s own MFA instead.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <TwoFactorCard enabled={twoFactor.enabled} recoveryCodesLeft={twoFactor.recoveryCodesLeft} />
            </CardContent>
          </Card>
        ) : null}
        {oidc ? (
          <Card>
            <CardHeader>
              <CardTitle>Single sign-on</CardTitle>
              <CardDescription>
                {row.oidc_issuer
                  ? "This account can sign in with SSO."
                  : "Link your identity provider account to sign in with SSO. Gantry never links accounts by email."}
              </CardDescription>
            </CardHeader>
            <CardContent>
              {row.oidc_issuer ? (
                <p className="text-sm">
                  Linked to <Mono>{row.oidc_issuer}</Mono>
                </p>
              ) : (
                <LinkSsoButton />
              )}
            </CardContent>
          </Card>
        ) : null}
        <Card>
          <CardHeader>
            <CardTitle>API tokens</CardTitle>
            <CardDescription>
              Personal tokens for scripts calling Gantry&apos;s <Mono>/api</Mono> endpoints with your permissions. They
              can&apos;t sign in to the web interface.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ApiTokensCard
              tokens={tokens.map((t) => ({
                id: t.id,
                name: t.name,
                prefix: t.prefix,
                createdLabel: timeAgo(t.created_at),
                expiresLabel: t.expires_at ? formatDate(t.expires_at) : "never",
                lastUsedLabel: t.last_used_at ? timeAgo(t.last_used_at) : "never",
                expired: Boolean(t.expires_at && Date.parse(t.expires_at) <= now),
              }))}
            />
          </CardContent>
        </Card>
      </div>
    </PageBody>
  )
}
