import { FileBrowser } from "@/components/gantry/file-browser"
import type { Permissions } from "@/lib/permissions"
import type { ContainerInspect } from "@/lib/server/docker/api"
import { filesLimits } from "@/lib/server/files/config"
import { deleteBlocker } from "@/lib/server/files/service"

/** Files tab of the container page (server part: limits and what's possible in this state). */
export function ContainerFiles({ container, can }: { container: ContainerInspect; can: Permissions }) {
  return (
    <FileBrowser
      target={{ kind: "container", id: container.Id }}
      rootLabel={container.Name.replace(/^\//, "")}
      canWrite={can.manage}
      deleteBlocker={deleteBlocker(container)}
      limits={filesLimits()}
    />
  )
}
