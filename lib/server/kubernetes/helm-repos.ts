import "server-only"

import { stringify } from "yaml"

import { decryptSecret, encryptSecret, SecretDecryptError } from "@/lib/server/crypto"
import { getDb } from "@/lib/server/db"
import { KubeError } from "@/lib/server/kubernetes/client"

// Helm chart repositories. Credentials are encrypted at rest and only
// decrypted into a private temp dir (repositories.yaml / registry config)
// for the duration of one helm command; they never reach the browser and
// are never written to helm's own (persistent) config.

const CONTEXT = "helm-repository.credentials"

export type RepoCredentials = { username: string; password: string }

/** A repository without its credentials (safe to render). */
export type HelmRepoInfo = { id: number; name: string; url: string; oci: boolean; username: string | null; updatedAt: string }

export type HelmRepo = HelmRepoInfo & { credentials: RepoCredentials | null }

type Row = { id: number; name: string; url: string; credentials: string | null; updated_at: string }

function decryptCredentials(row: Row): RepoCredentials | null {
  if (!row.credentials) return null
  try {
    const parsed = JSON.parse(decryptSecret(row.credentials, CONTEXT)) as RepoCredentials
    return parsed && typeof parsed.username === "string" && typeof parsed.password === "string" ? parsed : null
  } catch (err) {
    if (err instanceof SecretDecryptError || err instanceof SyntaxError) {
      throw new KubeError(`The credentials of chart repository ${row.name} can't be decrypted (was GANTRY_SECRET changed?). Add the repository again.`, 500)
    }
    throw err
  }
}

function info(row: Row, username: string | null): HelmRepoInfo {
  return { id: row.id, name: row.name, url: row.url, oci: row.url.startsWith("oci://"), username, updatedAt: row.updated_at }
}

export async function listHelmRepos(): Promise<HelmRepoInfo[]> {
  const db = await getDb()
  const rows = await db.selectFrom("helm_repositories").select(["id", "name", "url", "credentials", "updated_at"]).orderBy("name").execute()
  return rows.map((r) => {
    let username: string | null = null
    try {
      username = decryptCredentials(r)?.username ?? null
    } catch {
      username = "(unreadable)"
    }
    return info(r, username)
  })
}

/** One repository with its decrypted credentials (server only). */
export async function getHelmRepo(id: number): Promise<HelmRepo | null> {
  const db = await getDb()
  const row = await db.selectFrom("helm_repositories").select(["id", "name", "url", "credentials", "updated_at"]).where("id", "=", id).executeTakeFirst()
  if (!row) return null
  const credentials = decryptCredentials(row)
  return { ...info(row, credentials?.username ?? null), credentials }
}

export async function findHelmRepoByName(name: string) {
  const db = await getDb()
  return db.selectFrom("helm_repositories").select(["id"]).where("name", "=", name).executeTakeFirst()
}

export async function insertHelmRepo(values: { name: string; url: string; credentials: RepoCredentials | null }) {
  const db = await getDb()
  const now = new Date().toISOString()
  const res = await db
    .insertInto("helm_repositories")
    .values({
      name: values.name,
      url: values.url,
      credentials: values.credentials ? encryptSecret(JSON.stringify(values.credentials), CONTEXT) : null,
      created_at: now,
      updated_at: now,
    })
    .executeTakeFirstOrThrow()
  return Number(res.insertId)
}

export async function deleteHelmRepo(id: number) {
  const db = await getDb()
  await db.deleteFrom("helm_repositories").where("id", "=", id).execute()
}

/**
 * The OCI repository whose address `ref` falls under (longest match), so
 * a typed oci:// reference can use the credentials stored for its registry.
 */
export async function helmRepoForOciRef(ref: string): Promise<HelmRepo | null> {
  const db = await getDb()
  const rows = await db.selectFrom("helm_repositories").select(["id", "name", "url", "credentials", "updated_at"]).where("url", "like", "oci://%").execute()
  const match = rows
    .filter((r) => ref === r.url || ref.startsWith(`${r.url}/`) || ref.startsWith(`oci://${ociHost(r.url)}/`))
    .sort((a, b) => b.url.length - a.url.length)[0]
  return match ? { ...info(match, null), credentials: decryptCredentials(match) } : null
}

/** helm's repositories.yaml listing one repository (credentials included: write it to a private dir only). */
export function repositoriesYaml(repo: Pick<HelmRepo, "name" | "url" | "credentials">): string {
  return stringify(
    {
      apiVersion: "",
      generated: "0001-01-01T00:00:00Z",
      repositories: [
        {
          name: repo.name,
          url: repo.url,
          username: repo.credentials?.username ?? "",
          password: repo.credentials?.password ?? "",
          certFile: "",
          keyFile: "",
          caFile: "",
          insecure_skip_tls_verify: false,
          pass_credentials_all: false,
        },
      ],
    },
    { lineWidth: 0 }
  )
}

/** The registry host[:port] of an oci:// address. */
export function ociHost(url: string): string {
  return url.replace(/^oci:\/\//, "").split("/")[0]
}

/** helm's registry config (Docker config.json format) with one login (private dir only). */
export function registryConfigJson(host: string, credentials: RepoCredentials | null): string {
  if (!credentials) return JSON.stringify({ auths: {} })
  const auth = Buffer.from(`${credentials.username}:${credentials.password}`).toString("base64")
  return JSON.stringify({ auths: { [host]: { auth } } })
}

/** Secrets of a repository login, as they could appear in output. */
export function credentialSecrets(credentials: RepoCredentials | null): string[] {
  if (!credentials) return []
  return [credentials.password, Buffer.from(`${credentials.username}:${credentials.password}`).toString("base64")]
}
