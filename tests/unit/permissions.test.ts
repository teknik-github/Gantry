import { describe, expect, it } from "vitest"

import {
  allows,
  ENVIRONMENT_ROLES,
  isEnvironmentRole,
  permissionsFor,
  roleFor,
  type EnvironmentPermission,
  type EnvironmentRole,
} from "@/lib/permissions"

const PERMISSIONS: EnvironmentPermission[] = ["view", "operate", "manage"]

// Expected rights per role: the matrix documented in README ("Security model").
const MATRIX: Record<EnvironmentRole | "none", Record<EnvironmentPermission, boolean>> = {
  none: { view: false, operate: false, manage: false },
  viewer: { view: true, operate: false, manage: false },
  operator: { view: true, operate: true, manage: false },
  manager: { view: true, operate: true, manage: true },
}

describe("per-environment roles", () => {
  it.each(Object.entries(MATRIX))("standard user with %s", (role, expected) => {
    const r = role === "none" ? null : (role as EnvironmentRole)
    for (const p of PERMISSIONS) expect(allows("user", r, p), `${role} → ${p}`).toBe(expected[p])
  })

  it("gives administrators every right, with or without a grant", () => {
    for (const r of [null, ...ENVIRONMENT_ROLES]) {
      for (const p of PERMISSIONS) expect(allows("admin", r, p)).toBe(true)
    }
  })

  it("names the least role for each permission", () => {
    expect(PERMISSIONS.map(roleFor)).toEqual(["viewer", "operator", "manager"])
  })

  it("derives UI flags from the same rules", () => {
    expect(permissionsFor("user", "operator")).toEqual({ view: true, operate: true, manage: false, admin: false })
    expect(permissionsFor("user", null)).toEqual({ view: false, operate: false, manage: false, admin: false })
    expect(permissionsFor("admin", null)).toEqual({ view: true, operate: true, manage: true, admin: true })
  })

  it("recognizes only the three roles", () => {
    expect(ENVIRONMENT_ROLES.every(isEnvironmentRole)).toBe(true)
    for (const v of ["admin", "Viewer", "", null, 1]) expect(isEnvironmentRole(v)).toBe(false)
  })
})
