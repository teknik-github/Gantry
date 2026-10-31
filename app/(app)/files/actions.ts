"use server"

import { z } from "zod"

import { joinPath } from "@/lib/files/paths"
import { expectedEnvironment, inEnvironment, runAction, UserError } from "@/lib/server/action"
import { createFolder, deletePath, describe, FilesError, parseName, parsePath, parseTarget, type FileTarget } from "@/lib/server/files/service"
import type { ActionState } from "@/lib/validation"

// File browser changes (containers and volumes). Uploads and saves stream
// through app/api/uploads/files; these are the small ones. Managers only,
// pinned to the environment the page showed, audited by runAction.

const targetSchema = z.union([
  z.object({ kind: z.literal("container"), id: z.string() }),
  z.object({ kind: z.literal("volume"), name: z.string() }),
])

function parse<T>(fn: () => T): T | { error: string } {
  try {
    return fn()
  } catch (err) {
    if (err instanceof FilesError) return { error: err.message }
    throw err
  }
}

function target(input: unknown): FileTarget {
  const parsed = targetSchema.safeParse(input)
  if (!parsed.success) throw new FilesError("Invalid target")
  return parseTarget(parsed.data.kind === "container" ? { container: parsed.data.id } : { volume: parsed.data.name })
}

/** FilesErrors are messages for the user. */
async function asUserError<T>(fn: () => Promise<T>) {
  try {
    return await fn()
  } catch (err) {
    if (err instanceof FilesError) throw new UserError(err.message)
    throw err
  }
}

export async function createFolderAction(
  targetInput: FileTarget,
  dir: string,
  name: string,
  environmentId?: number
): Promise<ActionState> {
  const input = parse(() => ({ t: target(targetInput), dir: parsePath(dir), name: parseName(name) }))
  if ("error" in input) return input
  const path = joinPath(input.dir, input.name)
  return runAction(inEnvironment("manage", expectedEnvironment(environmentId)), "files.mkdir", describe(input.t, path), async ({ docker }) => {
    await asUserError(async () => createFolder(await docker(), input.t, input.dir, input.name))
    return `Folder ${input.name} created`
  })
}

export async function deletePathAction(targetInput: FileTarget, path: string, environmentId?: number): Promise<ActionState> {
  const input = parse(() => ({ t: target(targetInput), path: parsePath(path) }))
  if ("error" in input) return input
  return runAction(inEnvironment("manage", expectedEnvironment(environmentId)), "files.delete", describe(input.t, input.path), async ({ docker }) => {
    await asUserError(async () => deletePath(await docker(), input.t, input.path))
    return `Deleted ${input.path}`
  })
}
