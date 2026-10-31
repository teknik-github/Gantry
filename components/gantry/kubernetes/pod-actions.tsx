"use client"

import { useRouter } from "next/navigation"
import { Trash2Icon } from "lucide-react"

import { deletePod } from "@/app/(app)/kubernetes/actions"
import { ConfirmAction } from "@/components/gantry/confirm-button"
import { Button } from "@/components/ui/button"
import { useI18n } from "@/lib/i18n/client"

/** Delete button of the pod page; goes back to the list afterwards. */
export function PodActions({ environmentId, namespace, name }: { environmentId: number; namespace: string; name: string }) {
  const router = useRouter()
  const { t, format } = useI18n()
  return (
    <ConfirmAction
      title={format(t.kubernetes.pods.deleteTitle, { name })}
      description={format(t.kubernetes.pods.deleteDescription, { namespace, name })}
      confirmLabel={t.common.actions.delete}
      onConfirm={async () => {
        const res = await deletePod({ environmentId, namespace, name })
        if (res.ok) router.push("/kubernetes/pods")
        return res
      }}
    >
      <Button variant="outline" size="sm">
        <Trash2Icon data-icon="inline-start" />
        {t.common.actions.delete}
      </Button>
    </ConfirmAction>
  )
}
