import "server-only"

import type { ManifestObject } from "@/lib/kubernetes/manifest"
import type { WorkloadKind } from "@/lib/kubernetes/names"
import { KubeError, kubeJson, kubeRaw, type KubeTarget } from "@/lib/server/kubernetes/client"

// The slices of Kubernetes objects Gantry reads. Everything is optional:
// the API omits empty fields.

export type ObjectMeta = {
  name: string
  namespace?: string
  uid?: string
  creationTimestamp?: string
  labels?: Record<string, string>
  annotations?: Record<string, string>
  deletionTimestamp?: string
  ownerReferences?: { kind: string; name: string }[]
}

type List<T> = { items: T[]; metadata?: { continue?: string } }

export type Node = {
  metadata: ObjectMeta
  status?: {
    conditions?: { type: string; status: string }[]
    nodeInfo?: { kubeletVersion?: string; osImage?: string; containerRuntimeVersion?: string; architecture?: string }
    addresses?: { type: string; address: string }[]
    capacity?: Record<string, string>
  }
  spec?: { unschedulable?: boolean }
}

export type Namespace = { metadata: ObjectMeta; status?: { phase?: string } }

export type ContainerState = {
  running?: { startedAt?: string }
  waiting?: { reason?: string; message?: string }
  terminated?: { reason?: string; exitCode?: number; message?: string }
}

export type ContainerStatus = {
  name: string
  ready: boolean
  restartCount: number
  image?: string
  state?: ContainerState
}

export type Pod = {
  metadata: ObjectMeta
  spec?: {
    nodeName?: string
    containers?: { name: string; image?: string }[]
    initContainers?: { name: string; image?: string }[]
  }
  status?: {
    phase?: string
    reason?: string
    podIP?: string
    startTime?: string
    containerStatuses?: ContainerStatus[]
    initContainerStatuses?: ContainerStatus[]
  }
}

export type Workload = {
  metadata: ObjectMeta
  spec?: {
    replicas?: number
    template?: { spec?: { containers?: { name: string; image?: string }[] } }
  }
  status?: {
    replicas?: number
    readyReplicas?: number
    updatedReplicas?: number
    availableReplicas?: number
    // DaemonSet
    desiredNumberScheduled?: number
    numberReady?: number
    updatedNumberScheduled?: number
  }
}

export type Service = {
  metadata: ObjectMeta
  spec?: {
    type?: string
    clusterIP?: string
    externalIPs?: string[]
    externalName?: string
    ports?: { name?: string; port: number; targetPort?: number | string; nodePort?: number; protocol?: string }[]
  }
  status?: { loadBalancer?: { ingress?: { ip?: string; hostname?: string }[] } }
}

export type Ingress = {
  metadata: ObjectMeta
  spec?: {
    ingressClassName?: string
    rules?: { host?: string; http?: { paths?: { path?: string }[] } }[]
    tls?: { hosts?: string[] }[]
  }
  status?: { loadBalancer?: { ingress?: { ip?: string; hostname?: string }[] } }
}

export type ConfigMap = { metadata: ObjectMeta; data?: Record<string, string>; binaryData?: Record<string, string> }

/** A Secret as Gantry keeps it: key names only, the values are dropped on arrival. */
export type SecretSummary = { metadata: ObjectMeta; type?: string; keys: string[] }

export type KubeEvent = {
  metadata: ObjectMeta
  type?: string
  reason?: string
  message?: string
  count?: number
  firstTimestamp?: string
  lastTimestamp?: string
  eventTime?: string
  involvedObject?: { kind?: string; name?: string; namespace?: string }
}

export type ApplyResult = {
  index: number
  kind: string
  name: string
  namespace: string | null
  status: "created" | "configured" | "error"
  message?: string
}

const WORKLOAD_PLURAL: Record<WorkloadKind, string> = {
  Deployment: "deployments",
  StatefulSet: "statefulsets",
  DaemonSet: "daemonsets",
}

const seg = encodeURIComponent

/** `/api/v1[/namespaces/<ns>]/<resource>`, or the /apis/<group> equivalent. */
function collectionPath(group: string, resource: string, namespace?: string | null) {
  const prefix = group === "v1" ? "/api/v1" : `/apis/${group}`
  return namespace ? `${prefix}/namespaces/${seg(namespace)}/${resource}` : `${prefix}/${resource}`
}

/** Kubernetes client bound to one cluster. */
export function kube(target: KubeTarget) {
  async function get<T>(path: string, query?: Record<string, string | number | undefined>) {
    return (await kubeJson<T>(target, { method: "GET", path, query })).data
  }

  /** Lists a resource in one namespace or (null) all of them, following pagination. */
  async function list<T>(group: string, resource: string, namespace?: string | null, query: Record<string, string | undefined> = {}) {
    const items: T[] = []
    let cont: string | undefined
    do {
      const page = await get<List<T>>(collectionPath(group, resource, namespace), { ...query, limit: 500, continue: cont })
      items.push(...(page.items ?? []))
      cont = page.metadata?.continue || undefined
    } while (cont && items.length < 20_000)
    return items
  }

  return {
    target,

    version: () => get<{ gitVersion: string; platform?: string }>("/version"),

    /** Throws when the credentials are rejected (discovery needs an authenticated user). */
    checkAccess: () => get<{ versions?: string[] }>("/api"),

    listNodes: () => list<Node>("v1", "nodes"),
    listNamespaces: () => list<Namespace>("v1", "namespaces"),
    listPods: (ns: string | null) => list<Pod>("v1", "pods", ns),
    getPod: (ns: string, name: string) => get<Pod>(`${collectionPath("v1", "pods", ns)}/${seg(name)}`),
    listServices: (ns: string | null) => list<Service>("v1", "services", ns),
    listIngresses: (ns: string | null) => list<Ingress>("networking.k8s.io/v1", "ingresses", ns),
    listConfigMaps: (ns: string | null) => list<ConfigMap>("v1", "configmaps", ns),
    /** Values never leave this function: only key names are kept. */
    async listSecrets(ns: string | null): Promise<SecretSummary[]> {
      const secrets = await list<{ metadata: ObjectMeta; type?: string; data?: Record<string, string> }>("v1", "secrets", ns)
      return secrets.map((s) => ({
        metadata: { name: s.metadata.name, namespace: s.metadata.namespace, creationTimestamp: s.metadata.creationTimestamp },
        type: s.type,
        keys: Object.keys(s.data ?? {}),
      }))
    },
    listEvents: (ns: string | null, type?: "Warning") =>
      list<KubeEvent>("v1", "events", ns, { fieldSelector: type ? `type=${type}` : undefined }),

    listWorkloads: (kind: WorkloadKind, ns: string | null) => list<Workload>("apps/v1", WORKLOAD_PLURAL[kind], ns),

    async podLogs(ns: string, name: string, opts: { container?: string; tailLines: number }) {
      const res = await kubeRaw(target, {
        method: "GET",
        path: `${collectionPath("v1", "pods", ns)}/${seg(name)}/log`,
        query: { container: opts.container, tailLines: opts.tailLines, timestamps: true, limitBytes: 5 * 1024 * 1024 },
        // The log endpoint answers text/plain but refuses an Accept header naming it (406).
        accept: "*/*",
        timeoutMs: 30_000,
      })
      return res.body.toString("utf8")
    },

    async deletePod(ns: string, name: string) {
      await kubeJson(target, { method: "DELETE", path: `${collectionPath("v1", "pods", ns)}/${seg(name)}` })
    },

    async scaleWorkload(kind: WorkloadKind, ns: string, name: string, replicas: number) {
      if (kind === "DaemonSet") throw new KubeError("DaemonSets run one pod per node and can't be scaled", 400)
      await kubeJson(target, {
        method: "PATCH",
        path: `${collectionPath("apps/v1", WORKLOAD_PLURAL[kind], ns)}/${seg(name)}/scale`,
        body: { spec: { replicas } },
        contentType: "application/merge-patch+json",
      })
    },

    /** Same as `kubectl rollout restart`: bumps an annotation on the pod template. */
    async restartWorkload(kind: WorkloadKind, ns: string, name: string, at = new Date()) {
      await kubeJson(target, {
        method: "PATCH",
        path: `${collectionPath("apps/v1", WORKLOAD_PLURAL[kind], ns)}/${seg(name)}`,
        body: { spec: { template: { metadata: { annotations: { "kubectl.kubernetes.io/restartedAt": at.toISOString() } } } } },
        contentType: "application/strategic-merge-patch+json",
        query: { fieldManager: "gantry" },
      })
    },

    async deleteWorkload(kind: WorkloadKind, ns: string, name: string) {
      await kubeJson(target, {
        method: "DELETE",
        path: `${collectionPath("apps/v1", WORKLOAD_PLURAL[kind], ns)}/${seg(name)}`,
        query: { propagationPolicy: "Background" },
      })
    },

    async createNamespace(name: string) {
      await kubeJson(target, {
        method: "POST",
        path: "/api/v1/namespaces",
        body: { apiVersion: "v1", kind: "Namespace", metadata: { name } },
        query: { fieldManager: "gantry" },
      })
    },

    async deleteNamespace(name: string) {
      await kubeJson(target, { method: "DELETE", path: `/api/v1/namespaces/${seg(name)}` })
    },

    /**
     * Server-side apply of manifest objects, one after another (so a
     * Namespace or CRD can precede what uses it). Namespaced objects without
     * metadata.namespace go to `namespace`; a different namespace in the
     * manifest is refused like `kubectl apply -n`. Failures don't stop the rest.
     */
    async apply(objects: ManifestObject[], opts: { namespace: string; force: boolean; dryRun: boolean }): Promise<ApplyResult[]> {
      const discovery = new Map<string, Promise<{ name: string; kind: string; namespaced: boolean }[]>>()
      const resourcesOf = (apiVersion: string) => {
        let p = discovery.get(apiVersion)
        if (!p) {
          const path = apiVersion === "v1" ? "/api/v1" : `/apis/${apiVersion}`
          p = get<{ resources?: { name: string; kind: string; namespaced: boolean }[] }>(path).then((r) => r.resources ?? [])
          discovery.set(apiVersion, p)
          // Retry after a failure: an earlier object may install the CRD.
          p.catch(() => discovery.delete(apiVersion))
        }
        return p
      }

      const results: ApplyResult[] = []
      for (const o of objects) {
        const base = { index: o.index, kind: o.kind, name: o.name }
        // Where it went (or would have gone): the chosen namespace once the kind is known to be namespaced.
        let ns: string | null = o.namespace
        try {
          let resources
          try {
            resources = await resourcesOf(o.apiVersion)
          } catch (err) {
            if (err instanceof KubeError && err.status === 404) {
              throw new KubeError(`apiVersion ${o.apiVersion} is not served by this cluster (is the CRD installed?)`, 400)
            }
            throw err
          }
          const resource = resources.find((r) => r.kind === o.kind && !r.name.includes("/"))
          if (!resource) throw new KubeError(`Kind ${o.kind} is not part of ${o.apiVersion}`, 400)

          const object = structuredClone(o.object) as { metadata: Record<string, unknown> }
          if (resource.namespaced) {
            if (o.namespace && o.namespace !== opts.namespace) {
              throw new KubeError(
                `The manifest sets namespace "${o.namespace}", which doesn't match the chosen namespace "${opts.namespace}"`,
                400
              )
            }
            ns = opts.namespace
            object.metadata.namespace = ns
          } else {
            ns = null
            delete object.metadata.namespace
          }

          const group = o.apiVersion === "v1" ? "v1" : o.apiVersion
          const res = await kubeJson(target, {
            method: "PATCH",
            path: `${collectionPath(group, resource.name, ns)}/${seg(o.name)}`,
            // JSON is valid YAML.
            body: JSON.stringify(object),
            contentType: "application/apply-patch+yaml",
            query: { fieldManager: "gantry", force: opts.force, dryRun: opts.dryRun ? "All" : undefined },
          })
          results.push({ ...base, namespace: ns, status: res.status === 201 ? "created" : "configured" })
        } catch (err) {
          const message = err instanceof KubeError ? err.message : "unexpected error"
          if (!(err instanceof KubeError)) console.error("[gantry] kubernetes apply failed", err)
          results.push({ ...base, namespace: ns, status: "error", message })
        }
      }
      return results
    },
  }
}

export type KubeApi = ReturnType<typeof kube>
