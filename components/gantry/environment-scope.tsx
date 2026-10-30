"use client"

import * as React from "react"

import { ENVIRONMENT_FIELD } from "@/lib/permissions"

// The environment a page was rendered for. Actions send it along so the
// server can refuse them when the selected environment changed in the
// meantime (e.g. switched in another tab), instead of acting on another host.

const EnvironmentIdContext = React.createContext<number | undefined>(undefined)

export function EnvironmentScope({ id, children }: { id: number | undefined; children: React.ReactNode }) {
  return <EnvironmentIdContext.Provider value={id}>{children}</EnvironmentIdContext.Provider>
}

/** Id of the environment the surrounding page shows; undefined outside one. */
export function useEnvironmentId() {
  return React.useContext(EnvironmentIdContext)
}

/** Hidden form field with the page's environment id (FormDialog adds it to every form). */
export function EnvironmentField() {
  const id = useEnvironmentId()
  return id === undefined ? null : <input type="hidden" name={ENVIRONMENT_FIELD} value={id} />
}
