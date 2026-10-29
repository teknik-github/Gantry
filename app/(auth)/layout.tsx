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
      <div className="relative hidden overflow-hidden bg-muted lg:block">
        <div
          aria-hidden
          className="absolute inset-0 opacity-60 [background-image:linear-gradient(to_right,var(--border)_1px,transparent_1px),linear-gradient(to_bottom,var(--border)_1px,transparent_1px)] [background-size:48px_48px] [mask-image:radial-gradient(ellipse_at_center,black_30%,transparent_75%)]"
        />
        <div className="relative flex h-full flex-col justify-end gap-3 p-10">
          <GantryMark className="size-10 rounded-lg [&_svg]:size-6" />
          <h2 className="text-3xl font-semibold tracking-tight">
            Manage your containers.
          </h2>
          <p className="max-w-md text-muted-foreground">
            Gantry gives you one place to run, inspect and clean up containers,
            images, volumes and networks across your Docker hosts.
          </p>
        </div>
      </div>
    </div>
  )
}
