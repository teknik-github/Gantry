"use client"

import Link from "next/link"
import { useRouter } from "next/navigation"
import { PencilIcon, Trash2Icon } from "lucide-react"

import { deleteTemplate } from "@/app/(app)/templates/actions"
import { ConfirmAction } from "@/components/gantry/confirm-button"
import { Button } from "@/components/ui/button"

/** Edit and delete for a custom template. */
export function TemplateAdminActions({ templateKey, title }: { templateKey: string; title: string }) {
  const router = useRouter()
  return (
    <div className="flex items-center gap-2">
      <Button size="sm" variant="outline" asChild>
        <Link href={`/templates/${templateKey}/edit`}>
          <PencilIcon data-icon="inline-start" />
          Edit
        </Link>
      </Button>
      <ConfirmAction
        title={`Delete template ${title}?`}
        description="Stacks deployed from it are not affected."
        confirmLabel="Delete"
        onConfirm={async () => {
          const res = await deleteTemplate(templateKey)
          if (res.ok) router.push("/templates")
          return res
        }}
      >
        <Button size="sm" variant="outline" className="text-destructive">
          <Trash2Icon data-icon="inline-start" />
          Delete
        </Button>
      </ConfirmAction>
    </div>
  )
}
