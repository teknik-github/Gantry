"use client"

import { useRouter } from "next/navigation"
import { Trash2Icon } from "lucide-react"

import { deletePod } from "@/app/(app)/kubernetes/actions"
import { ConfirmAction } from "@/components/gantry/confirm-button"
import { Button } from "@/components/ui/button"

/** Delete button of the pod page; goes back to the list afterwards. */
export function PodActions({ environmentId, namespace, name }: { environmentId: number; namespace: string; name: string }) {
  const router = useRouter()
  return (
    <ConfirmAction
      title={`Delete pod ${name}?`}
      description={`Pod ${namespace}/${name} is stopped and removed. If a controller (Deployment, StatefulSet, ...) owns it, a replacement is started.`}
      confirmLabel="Delete"
      onConfirm={async () => {
        const res = await deletePod({ environmentId, namespace, name })
        if (res.ok) router.push("/kubernetes/pods")
        return res
      }}
    >
      <Button variant="outline" size="sm">
        <Trash2Icon data-icon="inline-start" />
        Delete
      </Button>
    </ConfirmAction>
  )
}
