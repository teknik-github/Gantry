"use client"

import { useTransition } from "react"
import { toast } from "sonner"

import { selectNamespace } from "@/app/(app)/kubernetes/actions"
import { Select, SelectContent, SelectItem, SelectSeparator, SelectTrigger, SelectValue } from "@/components/ui/select"

const ALL = "__all__"

/**
 * Namespace filter of the Kubernetes list pages. The choice is kept per
 * environment in a cookie, so every list page shows the same namespace.
 */
export function NamespaceSelect({
  environmentId,
  namespaces,
  selected,
}: {
  environmentId: number
  namespaces: string[]
  selected: string | null
}) {
  const [pending, startTransition] = useTransition()
  // The selected namespace may not be listable (namespaced service accounts).
  const options = selected && !namespaces.includes(selected) ? [selected, ...namespaces] : namespaces

  return (
    <Select
      value={selected ?? ALL}
      disabled={pending}
      onValueChange={(value) =>
        startTransition(async () => {
          const res = await selectNamespace(environmentId, value === ALL ? null : value)
          if (res.error) toast.error(res.error)
        })
      }
    >
      <SelectTrigger size="sm" className="w-56" aria-label="Namespace">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={ALL}>All namespaces</SelectItem>
        {options.length ? <SelectSeparator /> : null}
        {options.map((ns) => (
          <SelectItem key={ns} value={ns}>
            {ns}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
