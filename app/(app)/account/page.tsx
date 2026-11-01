import type { Metadata } from "next"

import { ChangePasswordForm } from "@/components/gantry/account-form"
import { ApiTokensCard, LinkSsoButton, TwoFactorCard } from "@/components/gantry/account-security"
import { PageBody } from "@/components/gantry/page-body"
import { LanguageSelect } from "@/components/i18n/language-switcher"
import { Mono, PageHeader } from "@/components/gantry/ui"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { listApiTokens } from "@/lib/server/auth/api-tokens"
import { requireUser } from "@/lib/server/auth/dal"
import { getOidcConfig, NO_PASSWORD } from "@/lib/server/auth/oidc"
import { twoFactorStatus } from "@/lib/server/auth/two-factor"
import { getDb } from "@/lib/server/db"
import { getI18n } from "@/lib/i18n/server"

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getI18n()).t.nav.pages.account }
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
  const i18n = await getI18n()
  const { t, format } = i18n
  const ssoMessages: Record<string, string> = t.account.ssoMessages
  const ssoMessage = typeof sso === "string" && Object.hasOwn(ssoMessages, sso) ? ssoMessages[sso] : undefined

  return (
    <PageBody>
      <PageHeader
        title={t.nav.pages.account}
        description={format(t.account.signedInAs, {
          username: user.username,
          role: user.role === "admin" ? t.account.roleAdmin : t.account.roleUser,
        })}
      />
      <div className="grid gap-4 px-4 lg:px-6">
        {ssoMessage ? (
          <p role="status" className="rounded-md border p-3 text-sm" data-testid="sso-message">
            {ssoMessage}
          </p>
        ) : null}
        <Card>
          <CardHeader>
            <CardTitle>{t.common.language.label}</CardTitle>
            <CardDescription>{t.common.language.description}</CardDescription>
          </CardHeader>
          <CardContent>
            <LanguageSelect className="w-full sm:w-64" />
          </CardContent>
        </Card>
        {hasPassword ? (
          <Card>
            <CardHeader>
              <CardTitle>{t.account.password.title}</CardTitle>
              <CardDescription>{t.account.password.description}</CardDescription>
            </CardHeader>
            <CardContent>
              <ChangePasswordForm />
            </CardContent>
          </Card>
        ) : null}
        {hasPassword ? (
          <Card>
            <CardHeader>
              <CardTitle>{t.account.twoFactor.title}</CardTitle>
              <CardDescription>{t.account.twoFactor.description}</CardDescription>
            </CardHeader>
            <CardContent>
              <TwoFactorCard enabled={twoFactor.enabled} recoveryCodesLeft={twoFactor.recoveryCodesLeft} />
            </CardContent>
          </Card>
        ) : null}
        {oidc ? (
          <Card>
            <CardHeader>
              <CardTitle>{t.account.sso.title}</CardTitle>
              <CardDescription>{row.oidc_issuer ? t.account.sso.linkedDescription : t.account.sso.linkDescription}</CardDescription>
            </CardHeader>
            <CardContent>
              {row.oidc_issuer ? (
                <p className="text-sm">{i18n.rich(t.account.sso.linkedTo, { issuer: <Mono>{row.oidc_issuer}</Mono> })}</p>
              ) : (
                <LinkSsoButton />
              )}
            </CardContent>
          </Card>
        ) : null}
        <Card>
          <CardHeader>
            <CardTitle>{t.account.tokens.title}</CardTitle>
            <CardDescription>{i18n.rich(t.account.tokens.description, { api: <Mono>/api</Mono> })}</CardDescription>
          </CardHeader>
          <CardContent>
            <ApiTokensCard
              tokens={tokens.map((token) => ({
                id: token.id,
                name: token.name,
                prefix: token.prefix,
                createdLabel: i18n.timeAgo(token.created_at),
                expiresLabel: token.expires_at ? i18n.formatDate(token.expires_at) : t.common.status.never,
                lastUsedLabel: token.last_used_at ? i18n.timeAgo(token.last_used_at) : t.common.status.never,
                expired: Boolean(token.expires_at && Date.parse(token.expires_at) <= now),
              }))}
            />
          </CardContent>
        </Card>
      </div>
    </PageBody>
  )
}
