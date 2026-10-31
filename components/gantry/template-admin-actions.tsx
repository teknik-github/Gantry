"use client"

import Link from "next/link"
import { useRouter } from "next/navigation"
import { PencilIcon, Trash2Icon } from "lucide-react"

import { deleteTemplate } from "@/app/(app)/templates/actions"
import { ConfirmAction } from "@/components/gantry/confirm-button"
import { Button } from "@/components/ui/button"
import { useI18n } from "@/lib/i18n/client"

/** Edit and delete for a custom template. */
export function TemplateAdminActions({ templateKey, title }: { templateKey: string; title: string }) {
  const i18n = useI18n()
  const { t } = i18n
  const router = useRouter()
  return (
    <div className="flex items-center gap-2">
      <Button size="sm" variant="outline" asChild>
        <Link href={`/templates/${templateKey}/edit`}>
          <PencilIcon data-icon="inline-start" />
          {t.common.actions.edit}
        </Link>
      </Button>
      <ConfirmAction
        title={i18n.format(t.templates.admin.deleteTitle, { title })}
        description={t.templates.admin.deleteDescription}
        confirmLabel={t.common.actions.delete}
        onConfirm={async () => {
          const res = await deleteTemplate(templateKey)
          if (res.ok) router.push("/templates")
          return res
        }}
      >
        <Button size="sm" variant="outline" className="text-destructive">
          <Trash2Icon data-icon="inline-start" />
          {t.common.actions.delete}
        </Button>
      </ConfirmAction>
    </div>
  )
}
