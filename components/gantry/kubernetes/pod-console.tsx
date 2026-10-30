"use client"

import * as React from "react"

import { startPodExecSession } from "@/app/(app)/kubernetes/exec-actions"
import { ExecConsole } from "@/components/gantry/exec-console"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"

/** kubectl exec in a container of the pod, through the shared console UI. */
export function PodConsole({
  environmentId,
  namespace,
  pod,
  containers,
  running,
}: {
  environmentId: number
  namespace: string
  pod: string
  containers: string[]
  running: boolean
}) {
  const [container, setContainer] = React.useState(containers[0] ?? "")
  return (
    <ExecConsole
      running={running}
      allowUser={false}
      description="Interactive shell inside a container of the pod (kubectl exec)"
      open={({ shell, cols, rows }) => startPodExecSession({ environmentId, namespace, pod, container, shell, cols, rows })}
      controls={
        containers.length > 1 ? (
          <Select value={container} onValueChange={setContainer}>
            <SelectTrigger size="sm" className="w-40" aria-label="Console container">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {containers.map((c) => (
                <SelectItem key={c} value={c}>
                  {c}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : null
      }
    />
  )
}
