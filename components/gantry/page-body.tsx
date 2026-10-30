import "server-only"

import { EnvironmentScope } from "@/components/gantry/environment-scope"
import { getCurrentEnvironment } from "@/lib/server/environments"

/**
 * Body of every app page. Provides the id of the environment the page is
 * rendered for to client components, which pass it to Server Actions.
 */
export async function PageBody({ children }: { children: React.ReactNode }) {
  const env = await getCurrentEnvironment()
  return (
    <div className="flex flex-col gap-4 py-4 md:gap-6 md:py-6">
      <EnvironmentScope id={env?.id}>{children}</EnvironmentScope>
    </div>
  )
}
