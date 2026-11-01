import { Suspense } from "react"

import { ContainerYard } from "@/components/container-yard"
import { GantryMark } from "@/components/gantry-logo"
import { LanguageSelect } from "@/components/i18n/language-switcher"
import { LocaleScope } from "@/components/i18n/locale-scope"
import { Skeleton } from "@/components/ui/skeleton"
import { getI18n } from "@/lib/i18n/server"

// login-02 shell: form on the left, brand panel on the right. Everything with
// text waits for the language cookie inside a Suspense boundary.
export default function AuthLayout({ children }: LayoutProps<"/">) {
  return (
    <div className="grid min-h-svh lg:grid-cols-2">
      <div className="flex flex-col gap-4 p-6 pt-[max(1.5rem,env(safe-area-inset-top))] md:p-10">
        <div className="flex items-center justify-between gap-2">
          <span className="flex items-center gap-2 font-medium">
            <GantryMark />
            Gantry
          </span>
          <Suspense fallback={null}>
            <LocaleScope>
              <LanguageSelect id="auth-language" className="w-auto" />
            </LocaleScope>
          </Suspense>
        </div>
        <div className="flex flex-1 items-center justify-center">
          <div className="w-full max-w-xs">
            <Suspense fallback={<Skeleton className="h-80 w-full" />}>
              <LocaleScope>{children}</LocaleScope>
            </Suspense>
          </div>
        </div>
      </div>
      <div className="relative hidden overflow-hidden bg-dock text-white lg:block">
        <ContainerYard className="absolute inset-x-10 top-16 w-[calc(100%-5rem)] max-w-xl" />
        <div className="relative flex h-full flex-col justify-end gap-3 p-10">
          <Suspense fallback={null}>
            <BrandText />
          </Suspense>
        </div>
      </div>
    </div>
  )
}

async function BrandText() {
  const { t } = await getI18n()
  return (
    <>
      <h2 className="max-w-md text-3xl font-semibold tracking-tight text-balance">{t.auth.brand.title}</h2>
      <p className="max-w-md text-white/70">{t.auth.brand.body}</p>
    </>
  )
}
