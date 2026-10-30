import { ContainerYard } from "@/components/container-yard"
import { GantryMark } from "@/components/gantry-logo"

// login-02 shell: form on the left, brand panel on the right.
export default function AuthLayout({ children }: LayoutProps<"/">) {
  return (
    <div className="grid min-h-svh lg:grid-cols-2">
      <div className="flex flex-col gap-4 p-6 md:p-10">
        <div className="flex justify-center gap-2 md:justify-start">
          <span className="flex items-center gap-2 font-medium">
            <GantryMark />
            Gantry
          </span>
        </div>
        <div className="flex flex-1 items-center justify-center">
          <div className="w-full max-w-xs">{children}</div>
        </div>
      </div>
      <div className="relative hidden overflow-hidden bg-dock text-white lg:block">
        <ContainerYard className="absolute inset-x-10 top-16 w-[calc(100%-5rem)] max-w-xl" />
        <div className="relative flex h-full flex-col justify-end gap-3 p-10">
          <h2 className="max-w-md text-3xl font-semibold tracking-tight text-balance">
            Every Docker host, stack and cluster in one yard.
          </h2>
          <p className="max-w-md text-white/70">
            Run, update and expose containers, deploy stacks from templates or Git, and get told when something
            goes wrong.
          </p>
        </div>
      </div>
    </div>
  )
}
