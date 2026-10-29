import "server-only"

import {
  formatArgs,
  formatPorts,
  parseEnv,
  parsePorts,
  parseVolumes,
  restartName,
  sameLines,
  splitArgs,
  type EditFormValues,
  type PortBinding,
  type PortBindings,
  type RestartPolicyName,
} from "@/lib/container-form"

// Recreating a container ("edit", "pull & recreate"): Docker can't change most
// settings of an existing container, so a new one is created from the old
// one's inspect output with only the edited fields changed.

// ---------------------------------------------------------------------------
// Inspect shapes (only what the mapping reads; everything else is copied).

type Json = Record<string, unknown>

export type InspectMount = {
  Type: string
  Name?: string
  Source: string
  Destination: string
  Mode?: string
  RW: boolean
}

export type HostMount = { Type: string; Source?: string; Target: string; ReadOnly?: boolean } & Json

export type EndpointInspect = {
  IPAMConfig?: { IPv4Address?: string; IPv6Address?: string; LinkLocalIPs?: string[] | null } | null
  Links?: string[] | null
  Aliases?: string[] | null
  DriverOpts?: Record<string, string> | null
  GwPriority?: number
  NetworkID?: string
} & Json

export type RecreateInspect = {
  Id: string
  Name: string
  Image: string
  State: { Status: string; Running: boolean; Paused: boolean; Restarting?: boolean }
  Config: {
    Hostname?: string
    Image: string
    Env?: string[] | null
    Cmd?: string[] | null
    Entrypoint?: string[] | null
    Labels?: Record<string, string> | null
    ExposedPorts?: Record<string, object> | null
    Volumes?: Record<string, object> | null
  } & Json
  HostConfig: {
    Binds?: string[] | null
    Mounts?: HostMount[] | null
    PortBindings?: PortBindings | null
    RestartPolicy?: { Name: string; MaximumRetryCount?: number } | null
    NetworkMode?: string
    AutoRemove?: boolean
    Links?: string[] | null
  } & Json
  Mounts?: InspectMount[] | null
  NetworkSettings: { Networks?: Record<string, EndpointInspect> | null }
}

export type ImageConfig = Json | null | undefined

/** Only the fields the user changed; everything else is taken from the old container. */
export type ContainerEdits = {
  image?: string
  name?: string
  /** null = use the image's default command. */
  cmd?: string[] | null
  env?: string[]
  ports?: Record<string, PortBinding[]>
  /** Lines as in the edit form: "source:/target[:opts]". */
  volumes?: string[]
  restart?: RestartPolicyName
  /** Networks to attach. The first one becomes the primary network unless the current one is kept. */
  networks?: string[]
}

export type CreatePlan = {
  name: string
  spec: Json
  /** Networks to connect after creating (the primary one is set at create time). */
  networks: { name: string; endpoint: Json }[]
}

export class RecreateError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "RecreateError"
  }
}

// ---------------------------------------------------------------------------
// Pure helpers

export function containerName(c: Pick<RecreateInspect, "Name" | "Id">) {
  return c.Name.replace(/^\//, "") || c.Id.slice(0, 12)
}

export function composeProject(c: Pick<RecreateInspect, "Config">) {
  return c.Config.Labels?.["com.docker.compose.project"] ?? null
}

type NetworkKind = "bridge" | "custom" | "host" | "none" | "container"

export function networkKind(mode: string | undefined): NetworkKind {
  if (!mode || mode === "default" || mode === "bridge") return "bridge"
  if (mode === "host" || mode === "none") return mode
  if (mode.startsWith("container:")) return "container"
  return "custom"
}

/** Only bridge/user-defined networking can be changed in the edit form. */
export function networksEditable(c: RecreateInspect) {
  const kind = networkKind(c.HostConfig.NetworkMode)
  return kind === "bridge" || kind === "custom"
}

/** Key in NetworkSettings.Networks of the network named by HostConfig.NetworkMode. */
function primaryNetworkKey(c: RecreateInspect): string | null {
  const mode = c.HostConfig.NetworkMode
  const nets = c.NetworkSettings.Networks ?? {}
  if (!networksEditable(c)) return null
  const wanted = !mode || mode === "default" ? "bridge" : mode
  if (wanted in nets) return wanted
  // NetworkMode may hold a network id instead of a name.
  const byId = Object.entries(nets).find(([, n]) => n.NetworkID && (n.NetworkID === wanted || n.NetworkID.startsWith(wanted)))
  return byId?.[0] ?? wanted
}

function bindTarget(bind: string) {
  return bind.split(":")[1] ?? ""
}

type MountEntry = { line: string; bind?: string; mount?: HostMount }

/**
 * Bind mounts and volumes as editable lines, each linked to the original
 * create input (a HostConfig.Binds string or a HostConfig.Mounts object, so
 * options survive). Anonymous volumes are pinned by name so their data is
 * reused instead of starting with a fresh, empty volume.
 */
export function mountEntries(c: RecreateInspect): { entries: MountEntry[]; fixed: HostMount[] } {
  const binds = c.HostConfig.Binds ?? []
  const hostMounts = c.HostConfig.Mounts ?? []
  const declared = new Set(Object.keys(c.Config.Volumes ?? {}))
  const usedBinds = new Set<number>()
  const usedMounts = new Set<number>()
  const entries: MountEntry[] = []
  const editable = (m: HostMount) => m.Type === "bind" || m.Type === "volume"
  const mountLine = (m: HostMount, source: string) => `${source}:${m.Target}${m.ReadOnly ? ":ro" : ""}`

  for (const m of c.Mounts ?? []) {
    if (m.Type !== "bind" && m.Type !== "volume") continue
    const bi = binds.findIndex((b, i) => !usedBinds.has(i) && bindTarget(b) === m.Destination)
    if (bi >= 0) {
      usedBinds.add(bi)
      entries.push({ line: binds[bi], bind: binds[bi] })
      continue
    }
    const mi = hostMounts.findIndex((hm, i) => !usedMounts.has(i) && editable(hm) && hm.Target === m.Destination)
    if (mi >= 0) {
      usedMounts.add(mi)
      const hm = hostMounts[mi]
      // `--mount type=volume,dst=/x` has no Source: pin the generated volume.
      const source = hm.Source || m.Name || ""
      entries.push({ line: mountLine(hm, source), mount: { ...hm, Source: source } })
      continue
    }
    // Anonymous volume from Config.Volumes (`-v /data` or the image's VOLUME).
    // Mounts not declared there come from VolumesFrom, which is kept as is.
    if (m.Type === "volume" && m.Name && declared.has(m.Destination)) {
      const line = `${m.Name}:${m.Destination}${m.RW ? "" : ":ro"}`
      entries.push({ line, bind: line })
    }
  }
  // Inputs without a matching inspect mount are still carried over.
  binds.forEach((b, i) => {
    if (!usedBinds.has(i)) entries.push({ line: b, bind: b })
  })
  hostMounts.forEach((hm, i) => {
    if (!usedMounts.has(i) && editable(hm)) entries.push({ line: mountLine(hm, hm.Source ?? ""), mount: hm })
  })
  return { entries, fixed: hostMounts.filter((m) => !editable(m)) }
}

/** Values to prefill the edit form with. */
export function formValuesFromInspect(c: RecreateInspect): EditFormValues {
  return {
    image: c.Config.Image,
    name: containerName(c),
    command: formatArgs(c.Config.Cmd),
    env: (c.Config.Env ?? []).join("\n"),
    ports: formatPorts(c.HostConfig.PortBindings),
    volumes: mountEntries(c)
      .entries.map((e) => e.line)
      .join("\n"),
    restart: restartName(c.HostConfig.RestartPolicy?.Name),
    networks: networksEditable(c) ? Object.keys(c.NetworkSettings.Networks ?? {}).sort() : [],
  }
}

/** Mounts the edit form can't change (tmpfs, …): shown as a note. */
export function fixedMountTargets(c: RecreateInspect) {
  const fromMounts = mountEntries(c).fixed.map((m) => `${m.Target} (${m.Type})`)
  const tmpfs = Object.keys((c.HostConfig.Tmpfs as Record<string, string> | null) ?? {}).map((t) => `${t} (tmpfs)`)
  return [...fromMounts, ...tmpfs]
}

export type EditSubmission = Omit<EditFormValues, "networks"> & { networks?: string[] }

type FormDiff =
  | { ok: true; edits: ContainerEdits }
  | { ok: false; error: string; fieldErrors: Record<string, string[]> }

const oneLine = (s: string) => s.replace(/[\r\n]+/g, "").trim()

/**
 * Compares the submitted form with the values derived from the container and
 * returns only what changed, validated like the create form. Unchanged fields
 * are not re-parsed, so exotic values Docker accepted are kept verbatim.
 */
export function editsFromForm(original: EditFormValues, submitted: EditSubmission, knownNetworks: string[]): FormDiff {
  const edits: ContainerEdits = {}
  const fail = (field: string, error: string, message: string): FormDiff => ({
    ok: false,
    error,
    fieldErrors: { [field]: [message] },
  })

  if (submitted.image.trim() !== original.image.trim()) edits.image = submitted.image.trim()
  if (submitted.name.trim() !== original.name) edits.name = submitted.name.trim()
  if (oneLine(submitted.command) !== oneLine(original.command)) {
    const cmd = splitArgs(submitted.command.trim())
    edits.cmd = cmd.length ? cmd : null
  }
  if (!sameLines(submitted.env, original.env)) {
    const r = parseEnv(submitted.env)
    if (!r.ok) return fail("env", r.error, r.fieldError)
    edits.env = r.value
  }
  if (!sameLines(submitted.ports, original.ports)) {
    const r = parsePorts(submitted.ports)
    if (!r.ok) return fail("ports", r.error, r.fieldError)
    edits.ports = r.value.bindings
  }
  if (!sameLines(submitted.volumes, original.volumes)) {
    const r = parseVolumes(submitted.volumes)
    if (!r.ok) return fail("volumes", r.error, r.fieldError)
    edits.volumes = r.value
  }
  if (submitted.restart !== original.restart) edits.restart = submitted.restart
  if (submitted.networks) {
    const next = [...new Set(submitted.networks)].sort()
    const unknown = next.find((n) => !knownNetworks.includes(n) && !original.networks.includes(n))
    if (unknown) return fail("networks", "Unknown network", `Network "${unknown}" does not exist`)
    if (next.join("\n") !== [...original.networks].sort().join("\n")) edits.networks = next
  }
  return { ok: true, edits }
}

function canonical(v: unknown): string {
  if (v === undefined || v === null) return "null"
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`
  if (typeof v === "object") {
    const o = v as Json
    return `{${Object.keys(o)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`)
      .join(",")}}`
  }
  return JSON.stringify(v)
}

const same = (a: unknown, b: unknown) => canonical(a) === canonical(b)

/**
 * Inspect shows the container config merged with the image config. Values
 * that equal the old image's defaults are dropped so that the (possibly new)
 * image supplies them — otherwise an updated image's ENV, CMD or labels would
 * be overridden by the stale ones (same approach as Watchtower).
 */
function stripImageDefaults(config: Json, image: Json) {
  for (const key of ["WorkingDir", "User", "StopSignal", "Shell", "OnBuild", "ArgsEscaped", "Healthcheck"]) {
    if (key in config && same(config[key], image[key])) delete config[key]
  }
  if (same(config.Entrypoint, image.Entrypoint)) {
    delete config.Entrypoint
    // An explicit entrypoint resets the image's CMD, so CMD is only an image
    // default when the entrypoint is as well.
    if (same(config.Cmd, image.Cmd)) delete config.Cmd
  }
  const imageLabels = (image.Labels ?? {}) as Record<string, string>
  const labels = { ...((config.Labels ?? {}) as Record<string, string>) }
  for (const [k, v] of Object.entries(imageLabels)) if (labels[k] === v) delete labels[k]
  config.Labels = labels
  const imagePorts = (image.ExposedPorts ?? {}) as Json
  const exposed = { ...((config.ExposedPorts ?? {}) as Json) }
  for (const k of Object.keys(imagePorts)) delete exposed[k]
  config.ExposedPorts = exposed
}

function stripImageEnv(env: string[], image: ImageConfig) {
  const defaults = new Set((image?.Env as string[] | null | undefined) ?? [])
  return env.filter((e) => !defaults.has(e))
}

/** Endpoint settings worth keeping (static IPs, aliases, links, driver options). */
export function endpointConfig(e: EndpointInspect | undefined, containerId: string): Json {
  if (!e) return {}
  const out: Json = {}
  const ipam = e.IPAMConfig
  if (ipam && (ipam.IPv4Address || ipam.IPv6Address || ipam.LinkLocalIPs?.length)) {
    out.IPAMConfig = Object.fromEntries(
      Object.entries(ipam).filter(([, v]) => (Array.isArray(v) ? v.length > 0 : Boolean(v)))
    )
  }
  // Older engines list the short container id as an alias; it would be stale.
  const aliases = (e.Aliases ?? []).filter((a) => a !== containerId.slice(0, 12) && a !== containerId)
  if (aliases.length) out.Aliases = aliases
  if (e.Links?.length) out.Links = e.Links
  if (e.DriverOpts && Object.keys(e.DriverOpts).length) out.DriverOpts = e.DriverOpts
  if (e.GwPriority) out.GwPriority = e.GwPriority
  return out
}

/** Inspect lists legacy links as "/other:/self/alias"; create wants "other:alias". */
function createLinks(links: string[] | null | undefined) {
  if (!links?.length) return undefined
  return links.map((l) => {
    const [source, target = ""] = l.split(":")
    const name = source.replace(/^\//, "")
    return `${name}:${target.split("/").pop() || name}`
  })
}

/**
 * Builds the /containers/create body for a replacement of `c`. Pure: the
 * caller decides what to do with it. `image` is the old image's Config
 * (from /images/{id}/json), used to tell image defaults from explicit values.
 */
export function buildCreateSpec(c: RecreateInspect, edits: ContainerEdits = {}, image?: ImageConfig): CreatePlan {
  const config: Json = structuredClone(c.Config)
  const host: Json = structuredClone(c.HostConfig)
  const kind = networkKind(c.HostConfig.NetworkMode)

  if (image) stripImageDefaults(config, image)
  if (edits.cmd !== undefined) {
    if (edits.cmd === null) delete config.Cmd
    else config.Cmd = edits.cmd
  }
  config.Env = stripImageEnv(edits.env ?? c.Config.Env ?? [], image)
  config.Image = edits.image ?? c.Config.Image

  // The default hostname is the container id prefix; a new id gets a new one.
  // Host / container network modes take the hostname from elsewhere.
  if (config.Hostname === c.Id.slice(0, 12) || kind === "host" || kind === "container") delete config.Hostname
  // Container-wide MAC addresses are deprecated (and runtime-assigned ones
  // must not be pinned); anonymous volumes are re-attached by name below.
  delete config.MacAddress
  delete config.Volumes

  // Ports
  const originalBindings = c.HostConfig.PortBindings ?? {}
  const bindings: PortBindings = edits.ports ?? structuredClone(originalBindings)
  const exposed = { ...((config.ExposedPorts ?? {}) as Json) }
  if (edits.ports) for (const k of Object.keys(originalBindings)) if (!(k in edits.ports)) delete exposed[k]
  for (const k of Object.keys(bindings)) exposed[k] = {}
  if (kind === "container") {
    // Shares another container's network stack: publishing is not allowed.
    delete config.ExposedPorts
    delete host.PortBindings
  } else {
    config.ExposedPorts = exposed
    host.PortBindings = bindings
  }

  // Mounts
  const { entries, fixed } = mountEntries(c)
  const byLine = new Map(entries.map((e) => [e.line, e]))
  const binds: string[] = []
  const mounts: HostMount[] = [...fixed]
  for (const line of edits.volumes ?? entries.map((e) => e.line)) {
    const e = byLine.get(line)
    if (e?.mount) mounts.push(e.mount)
    else binds.push(e?.bind ?? line)
  }
  host.Binds = binds.length ? binds : null
  host.Mounts = mounts.length ? mounts : null

  // Restart policy (a retry count is only valid with on-failure)
  if (edits.restart) {
    const keepCount = edits.restart === "on-failure" && c.HostConfig.RestartPolicy?.Name === "on-failure"
    host.RestartPolicy = {
      Name: edits.restart,
      MaximumRetryCount: keepCount ? (c.HostConfig.RestartPolicy?.MaximumRetryCount ?? 0) : 0,
    }
  }

  host.Links = createLinks(c.HostConfig.Links)
  delete host.ContainerIDFile

  // Networks: the primary one at create time, the rest connected afterwards.
  let networks: CreatePlan["networks"] = []
  let networkingConfig: Json | undefined
  if (kind === "bridge" || kind === "custom") {
    const current = c.NetworkSettings.Networks ?? {}
    const currentPrimary = primaryNetworkKey(c)!
    const wanted = edits.networks ?? Object.keys(current)
    if (!wanted.includes(currentPrimary) && edits.networks) {
      host.NetworkMode = wanted[0] ?? "none"
    }
    const primary = wanted.includes(currentPrimary) || !edits.networks ? currentPrimary : wanted[0]
    if (primary) {
      networkingConfig = { EndpointsConfig: { [primary]: endpointConfig(current[primary], c.Id) } }
    }
    networks = wanted
      .filter((n) => n !== primary)
      .map((n) => ({ name: n, endpoint: endpointConfig(current[n], c.Id) }))
  }

  const spec: Json = { ...config, HostConfig: host }
  if (networkingConfig) spec.NetworkingConfig = networkingConfig
  return { name: edits.name ?? containerName(c), spec, networks }
}

// ---------------------------------------------------------------------------
// Gantry's own container

export type SelfIds = { ids: string[]; hostnames: string[] }

/** Container ids Gantry itself may be running in, from /proc and the hostname. */
export function parseSelfIds(input: { cgroup?: string; mountinfo?: string; hostnames?: (string | undefined)[] }): SelfIds {
  const ids = new Set<string>()
  for (const m of (input.cgroup ?? "").matchAll(/(?:\/docker\/|docker-|libpod-)([a-f0-9]{64})/g)) ids.add(m[1])
  // Inside a container, /etc/hostname etc. are bind-mounted from the engine's
  // per-container directory: ".../containers/<id>/hostname /etc/hostname".
  for (const m of (input.mountinfo ?? "").matchAll(
    /\/containers\/([a-f0-9]{64})\/(?:hostname|hosts|resolv\.conf) \/etc\/(?:hostname|hosts|resolv\.conf) /g
  )) {
    ids.add(m[1])
  }
  const hostnames = (input.hostnames ?? []).filter((h): h is string => Boolean(h && /^[a-f0-9]{12}$/.test(h)))
  return { ids: [...ids], hostnames: [...new Set(hostnames)] }
}

export function isSelfContainer(c: Pick<RecreateInspect, "Id">, self: SelfIds | undefined) {
  if (!self) return false
  return self.ids.includes(c.Id) || self.hostnames.some((h) => c.Id.startsWith(h))
}

/** Why this container can't be recreated, or null. */
export function recreateBlocker(c: RecreateInspect, self?: SelfIds): string | null {
  if (isSelfContainer(c, self)) {
    return "This is Gantry's own container. Recreating it would stop Gantry in the middle of the request; update it from the host instead (e.g. docker compose pull && docker compose up -d)."
  }
  if (c.HostConfig.AutoRemove) {
    return "This container was started with --rm (auto-remove): stopping it would delete it, so it can't be recreated safely."
  }
  if (c.State.Paused) return "Resume the container before recreating it."
  if (c.State.Status === "removing" || c.State.Status === "dead") {
    return `The container is ${c.State.Status} and can't be recreated.`
  }
  return null
}

// ---------------------------------------------------------------------------
// Safe swap with rollback

/** The subset of the Docker API the swap needs (injectable for tests). */
export interface RecreateApi {
  inspectContainer(id: string): Promise<unknown>
  inspectImage(reference: string): Promise<{ Id: string; Config: Json | null }>
  pullImage(reference: string): Promise<void>
  containerAction(id: string, action: "start" | "stop"): Promise<unknown>
  renameContainer(id: string, name: string): Promise<unknown>
  createContainer(name: string | undefined, spec: Json): Promise<{ Id: string; Warnings?: string[] | null }>
  connectNetwork(network: string, container: string, endpoint?: Json): Promise<unknown>
  removeContainer(id: string, opts?: { force?: boolean; volumes?: boolean }): Promise<unknown>
}

export type RecreateResult = {
  id: string
  name: string
  previousId: string
  /** Non-fatal problems (e.g. the old container could not be removed). */
  warnings: string[]
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err))
const isTimeout = (err: unknown) => /timed out/i.test(message(err))
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/** Id of a container called `name` other than `exclude`, polling up to `waitMs`. */
async function findCreated(
  api: RecreateApi,
  name: string,
  exclude: string,
  waitMs: number,
  sleep: (ms: number) => Promise<void> = delay
): Promise<string | undefined> {
  for (let waited = 0; ; waited += 3_000) {
    const found = (await api.inspectContainer(name).catch(() => null)) as { Id?: string; Name?: string } | null
    // Inspect also resolves id prefixes: only accept an exact name match.
    if (found?.Id && found.Id !== exclude && found.Name === `/${name}`) return found.Id
    if (waited >= waitMs) return undefined
    await sleep(3_000)
  }
}

/**
 * Replaces a container with a new one built from its config plus `edits`:
 * stop → rename old → create → connect networks → start → remove old.
 * If anything after the rename fails the new container is removed and the
 * old one gets its name back (and is started again if it was running).
 */
export async function recreateContainer(
  api: RecreateApi,
  opts: {
    id: string
    edits?: ContainerEdits
    pull?: boolean
    self?: SelfIds
    now?: () => number
    /** How long to look for a container whose create request timed out (ms). */
    ghostWaitMs?: number
    sleep?: (ms: number) => Promise<void>
  }
): Promise<RecreateResult> {
  const old = (await api.inspectContainer(opts.id)) as RecreateInspect
  const blocker = recreateBlocker(old, opts.self)
  if (blocker) throw new RecreateError(blocker)

  const name = containerName(old)
  const edits = opts.edits ?? {}
  const imageRef = edits.image ?? old.Config.Image

  // Everything that can fail without side effects happens first.
  if (opts.pull) {
    await api.pullImage(imageRef)
  } else if (imageRef !== old.Config.Image) {
    try {
      await api.inspectImage(imageRef)
    } catch {
      throw new RecreateError(`Image "${imageRef}" is not available locally. Enable "Pull image" and try again.`)
    }
  }
  const oldImage = await api.inspectImage(old.Image).then(
    (i) => i.Config,
    () => null // image gone: keep every value explicitly
  )
  const plan = buildCreateSpec(old, edits, oldImage)
  if (plan.name !== name && (await findCreated(api, plan.name, old.Id, 0))) {
    throw new RecreateError(`A container named "${plan.name}" already exists.`)
  }

  const wasRunning = old.State.Running
  const parkedName = `${name}-gantry-old-${(opts.now ?? Date.now)()}`
  const warnings: string[] = []

  if (wasRunning) {
    try {
      await api.containerAction(old.Id, "stop")
    } catch (err) {
      await api.containerAction(old.Id, "start").catch(() => {})
      throw new RecreateError(`Could not stop ${name}: ${message(err)}. Nothing was changed.`)
    }
  }

  try {
    await api.renameContainer(old.Id, parkedName)
  } catch (err) {
    // A timed-out request may still have been applied: best-effort undo.
    if (isTimeout(err)) await api.renameContainer(old.Id, name).catch(() => {})
    const restarted = wasRunning ? await api.containerAction(old.Id, "start").then(() => true, () => false) : true
    throw new RecreateError(
      `Could not rename ${name}: ${message(err)}. ${restarted ? "The original container was left as it was." : `The original container could not be started again; start ${name} manually.`}`
    )
  }

  let newId: string | undefined
  let step = "creating the new container"
  try {
    const created = await api.createContainer(plan.name, plan.spec)
    newId = created.Id
    warnings.push(...(created.Warnings ?? []))
    for (const n of plan.networks) {
      step = `connecting it to network "${n.name}"`
      await api.connectNetwork(n.name, newId, n.endpoint)
    }
    if (wasRunning) {
      step = "starting the new container"
      await api.containerAction(newId, "start")
    }
  } catch (err) {
    const problems: string[] = []
    if (!newId) {
      // The engine may have created it even though the request failed (e.g.
      // timed out on a busy host); it would hold the name we need back.
      // Only after a timeout: any other error means it was definitely not
      // created (and the name was checked to be free before we started).
      if (isTimeout(err)) newId = await findCreated(api, plan.name, old.Id, opts.ghostWaitMs ?? 30_000, opts.sleep)
    }
    if (newId) {
      await api.removeContainer(newId, { force: true }).catch((e) => {
        problems.push(`the new container ${newId!.slice(0, 12)} could not be removed (${message(e)})`)
      })
    }
    let restoredName = name
    await api.renameContainer(old.Id, name).catch((e) => {
      restoredName = parkedName
      problems.push(`the original container could not be renamed back and is kept as "${parkedName}" (${message(e)})`)
    })
    if (wasRunning) {
      await api.containerAction(old.Id, "start").catch((e) => {
        problems.push(`the original container could not be started again (${message(e)})`)
      })
    }
    const outcome = problems.length
      ? `Rollback incomplete: ${problems.join("; ")}.`
      : `Rolled back: ${restoredName} is ${wasRunning ? "running" : "back"} with its previous settings.`
    throw new RecreateError(`Recreating ${name} failed while ${step}: ${message(err)}. ${outcome}`)
  }

  // The replacement is in place; failing to clean up is only a warning.
  // Volumes are kept: the new container uses them.
  try {
    await api.removeContainer(old.Id, { force: true, volumes: false })
  } catch (err) {
    warnings.push(`The previous container is kept as "${parkedName}" (${message(err)}); remove it when you no longer need it.`)
  }

  return { id: newId, name: plan.name, previousId: old.Id, warnings }
}

const IMAGE_ID_RE = /^(sha256:)?[a-f0-9]{12,64}$/

/**
 * "Update this container": pulls the image reference it was created from and
 * recreates it with identical settings when the pull produced a new image.
 */
export async function pullAndRecreate(
  api: RecreateApi,
  opts: { id: string; self?: SelfIds; now?: () => number }
): Promise<({ updated: true } & RecreateResult) | { updated: false; image: string }> {
  const old = (await api.inspectContainer(opts.id)) as RecreateInspect
  const blocker = recreateBlocker(old, opts.self)
  if (blocker) throw new RecreateError(blocker)

  const ref = old.Config.Image
  if (IMAGE_ID_RE.test(ref)) {
    throw new RecreateError("This container was created from an image ID, not a name:tag, so there is nothing to pull.")
  }
  await api.pullImage(ref)
  const latest = await api.inspectImage(ref)
  if (latest.Id === old.Image) return { updated: false, image: ref }

  const result = await recreateContainer(api, { id: old.Id, self: opts.self, now: opts.now })
  return { updated: true, ...result }
}
