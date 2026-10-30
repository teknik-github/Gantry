# Gantry

A Portainer-style web UI for Docker (and Kubernetes), built with Next.js 16 and shadcn/ui
(`login-02` for authentication, `dashboard-01` for the app shell).

- Dashboard with container/image/volume/network totals, live CPU/memory usage
  and history (1 h / 24 h / 7 d)
- Pages update live from Docker events (no reload needed)
- Containers: list, start/stop/restart/pause/kill, remove, create, inspect, live logs,
  interactive console (`docker exec` in the browser), **edit & recreate** and
  **pull & recreate** (update to the latest image)
- **Stacks**: create, edit and deploy docker compose projects; existing compose
  projects are listed and can be imported
- **Topology**: interactive map of compose projects, containers, networks,
  volumes and `depends_on` relations
- Images (pull, remove, prune), volumes and networks (create, remove)
- **Private registries**: store logins (encrypted) for GHCR, GitLab, Docker Hub
  or your own registry; used for pulls, recreate, update checks and stacks
- **Image updates**: containers whose tag has a newer image in the registry
  get an "update" badge; update them one by one or in bulk
- **Templates**: 35 ready-made stacks (databases, WordPress, Nextcloud,
  monitoring, Gitea, n8n, Keycloak, Ollama + Open WebUI, ...) plus your own
  templates from any compose file
- **Notifications**: alerts to Telegram, Discord, Slack, ntfy, email (SMTP) or any webhook
  when containers crash, run out of memory, turn unhealthy or restart-loop,
  when an environment is unreachable, and for image updates
- **Auto-update**: scheduled daily updates for the containers you choose
  (or label `gantry.auto-update=true`), rolled back on failure
- **Reverse proxy**: serve containers under domain names with automatic HTTPS,
  through a built-in Caddy proxy or the proxy you already run
- **Bulk actions**: tick several containers, images, volumes or networks and
  start/stop/restart/pause/resume/kill or remove them at once
- Multiple Docker environments: local socket or TCP, optionally with mutual TLS;
  standard users only see the environments they were given
- **Kubernetes environments**: connect a cluster with a service account token
  or a kubeconfig; overview (nodes, namespaces, pods by phase), workloads
  (scale, rollout restart, delete), pods (status, logs, delete), services and
  ingresses, namespaces, ConfigMaps and Secrets (names and keys only), warning
  events, and **Apply manifest** (multi-document YAML, server-side apply)
- Users with `admin` / `user` roles, plus an activity log
- Database: **SQLite** (default) or **MySQL**, chosen with `DB_DRIVER`

## Run with Docker Compose

```bash
cp .env.example .env
# Set DOCKER_GID to the group that owns the socket on the host:
stat -c '%g' /var/run/docker.sock

# SQLite (default)
docker compose up -d --build

# MySQL: set DB_DRIVER=mysql and COMPOSE_PROFILES=mysql in .env, or:
DB_DRIVER=mysql COMPOSE_PROFILES=mysql docker compose up -d --build
```

Open http://localhost:3000. On first visit you create the administrator
account; `/setup` asks for a one-time **setup token** that only someone with
access to the server can read:

```bash
docker logs gantry 2>&1 | grep -A2 "setup token"
```

To skip `/setup` (e.g. for automated installs), set `GANTRY_ADMIN_USERNAME`
and `GANTRY_ADMIN_PASSWORD`; the admin is created on startup.

## Development

```bash
pnpm install
pnpm dev -H 0.0.0.0 -p 3001   # SQLite at ./data/gantry.db
```

Extra hosts that load the dev server are listed in `allowedDevOrigins` in
`next.config.ts`.

## Tests

```bash
pnpm test        # unit + integration tests (Vitest)
pnpm test:e2e    # E2E (Playwright) against a production build
```

`pnpm test:e2e` builds the app, starts the standalone server on port 3100 with
a fresh SQLite database, and runs the login suite first (it creates the admin
the other suites use). The Docker-backed suites (console, stacks, recreate,
topology, live updates, environments) create throwaway `gantry-test-*`
containers/networks/volumes labelled `gantry.e2e=true` and remove them
afterwards; they are skipped when Docker isn't reachable. Useful switches:

- `E2E_SKIP_BUILD=1` reuses the last `pnpm build` (handy on a slow machine:
  run `pnpm build` first, since the web server start times out after 5 minutes)
- `E2E_BASE_URL=http://host:port` targets a running, not-yet-set-up Gantry instead
- `E2E_PORT` changes the port (default 3100)

Unit/integration extras:

- The TLS tests need `openssl` and the Docker socket (they run a local mTLS
  proxy in front of it).
- `GANTRY_DOCKER_IT=1` also runs the recreate tests against real Docker.
- `GANTRY_TEST_MYSQL_URL=mysql://…` also runs the migration/access tests on
  MySQL. The database is wiped, so point it at a throwaway one.

The first run needs a browser: `pnpm exec playwright install chromium`.

The Kubernetes suite (`tests/e2e/kubernetes.spec.ts`) needs a **throwaway**
cluster (it creates and deletes a namespace and adds the cluster as an
environment) and is skipped otherwise. Never point it at a real cluster:

```bash
kind create cluster --name gantry-k8s-e2e --kubeconfig /tmp/gantry-k8s-e2e.kubeconfig
GANTRY_E2E_KUBECONFIG=/tmp/gantry-k8s-e2e.kubeconfig \
  GANTRY_E2E_KUBE_TOKEN="$(kubectl --kubeconfig /tmp/gantry-k8s-e2e.kubeconfig -n kube-system create token gantry-admin)" \
  pnpm test:e2e tests/e2e/login.spec.ts tests/e2e/kubernetes.spec.ts
kind delete cluster --name gantry-k8s-e2e
```

`GANTRY_E2E_KUBE_TOKEN` is optional (a cluster-admin service account token,
see below; it also tests the token form). The test workload runs `alpine:3`.

## Configuration

| Variable | Default | Description |
| --- | --- | --- |
| `DB_DRIVER` | `sqlite` | `sqlite` or `mysql` |
| `SQLITE_PATH` | `$DATA_DIR/gantry.db` | SQLite file |
| `DATABASE_URL` / `MYSQL_*` | | MySQL connection |
| `DATA_DIR` | `./data` (`/data` in Docker) | SQLite and the generated secret |
| `GANTRY_SECRET` | generated | Session signing key (≥ 32 characters) |
| `COOKIE_SECURE` | `auto` | `true`, `false` or `auto` (Secure behind HTTPS) |
| `SESSION_TTL_HOURS` | `12` | Session lifetime |
| `GANTRY_SETUP_TOKEN` | generated | Token `/setup` asks for (≥ 16 chars); otherwise random, logged and kept in `$DATA_DIR/setup-token` |
| `GANTRY_ADMIN_USERNAME` / `GANTRY_ADMIN_PASSWORD` | | Create the first admin at startup instead of `/setup` |
| `TRUST_PROXY` | `false` | Trust `X-Forwarded-For` from your reverse proxy (per-client login limits) |
| `DOCKER_SOCKET` | `/var/run/docker.sock` | Socket of the default `local` environment |
| `METRICS_INTERVAL_SECONDS` | `60` | How often the dashboard history is sampled (minimum 10) |
| `METRICS_RETENTION_DAYS` | `7` | How long history is kept |
| `UPDATE_CHECK_INTERVAL_HOURS` | `6` | How often registries are asked about newer images (`0` = only on demand) |

## Features in more detail

### Stacks

- Stacks run the `docker compose` CLI (included in the image) against the
  selected environment, over its socket or TCP (with TLS when configured).
- Files live in `DATA_DIR/stacks/<envId>-<name>/`. **Relative paths in a
  compose file (bind mounts, `build:`, `env_file:`) resolve inside Gantry's
  container, not on the Docker host** — use absolute host paths or named volumes.
- The stack's `.env` text is used for `${VAR}` substitution; add
  `env_file: .env` to a service to pass the values into its containers.
  Gantry's own environment (secrets, DB credentials) is never exposed to
  compose files.
- Private registries: add them under **Registries** (or mount a docker
  `config.json` and set `DOCKER_CONFIG`).
- Stack names are compose project names (`^[a-z0-9][a-z0-9_-]{0,62}$`). A name
  that matches an existing compose project is refused; use **Import** instead.
  Import reads the compose file named in the project's labels, so it is only
  offered for the local socket environment (whose files Gantry can see).
- The compose file and the deploy output may contain secrets, so only
  administrators can see them (standard users see the variable names).
- Changes are admin-only, since compose files can bind-mount anything on the host.

### Edit / recreate containers

- **Edit** changes image, name, command, env, ports, volumes, restart policy
  and networks by recreating the container; everything else (labels,
  healthcheck, devices, capabilities, mount options, network aliases, …) is
  kept. **Pull & recreate** updates a container to the newest image with the
  same configuration (or reports that it's already up to date).
- The old container is parked as `<name>-gantry-old-<timestamp>` during the
  swap and restored if anything fails.
- Containers from a compose project get a warning: the next redeploy of the
  project overwrites the changes.
- Gantry refuses to recreate its own container; update it from the host with
  `docker compose pull && docker compose up -d`.

### Topology

`/topology` is a read-only map of the current environment. Built-in networks
(`bridge`/`host`/`none`) and bind mounts are hidden by default (toggles);
unused networks and volumes are not drawn. Deep link to one project with
`/topology?project=<name>`. The map is built from the Docker API on every
request (no stored copy) and redraws itself on Docker events.

### Bulk actions

The container, image, volume and network lists have checkboxes. "Select all"
ticks every row that matches the search (across pages). Each container action
only counts the containers it applies to (e.g. Stop skips stopped ones).
Removal asks for confirmation and lists what will go. Objects that fail (in
use, running without force) are reported by name and stay selected; the rest
are still done. Standard users get the start/stop actions only; built-in
networks can't be selected; the container Gantry runs in is skipped for
stop/restart/pause/kill/remove. At most 200 objects per request.

### Registries

Administrators add logins under **Registries** (address such as `ghcr.io`,
`registry.gitlab.com`, `registry.example.com:5000` or `docker.io`, plus a
username and password or token). Gantry checks the login before saving (can be
switched off). Passwords are encrypted like TLS keys and never sent to the
browser; leave the field empty when editing to keep the stored one.

The login for an image's registry is used automatically for every pull through
the Engine API (Images, create, recreate, update) and for `docker compose`:
each stack run gets a private, temporary `DOCKER_CONFIG` with the logins
(merged over a mounted `DOCKER_CONFIG`, whose `cli-plugins` stay available).

### Image updates

Gantry asks the registry which digest a tag currently points to (`GET
/distribution`, no pull) and compares it with the image each container runs.
Containers with a newer image get an **update** badge on the Containers page and
dashboard; search for "update" to list only them. "Check updates" asks right
away; otherwise every environment is checked every `UPDATE_CHECK_INTERVAL_HOURS`
(results are kept in memory). To update, select the containers and choose
**Update** (pull & recreate, two at a time, rolled back on failure). Containers
pinned to a digest or an image id, and images built locally, are not checked.
Containers from a compose project are recreated with the same settings, but the
project's next `docker compose up` uses its compose file again.

### Templates

**Templates** lists 35 built-in stacks and your own. Deploying one asks for a
stack name and the template's variables (ports, users, passwords: empty
password fields are generated), writes them to the stack's `.env` and runs
`docker compose up -d`; the result is a normal stack you can edit later.

Custom templates are any compose file: `${NAME}` becomes a field on the deploy
form, `${NAME:-default}` gets a default, `${NAME:?}` is required, and the
"Default values" box can set more defaults. Names containing `PASSWORD`,
`SECRET`, `TOKEN` or ending in `KEY` become generated password fields. A
deployed stack can be turned into a template with **Save as template** on its
page (secret-looking values are left empty). Variables such as `TZ`, `HOME` or
`PATH` are refused because `docker compose` would read them from Gantry's own
environment instead of `.env`.

### Notifications

Administrators add channels under **Notifications**: Telegram (bot token +
chat id), Discord or Slack (incoming webhook URL), ntfy (server + topic,
optional token), email through any SMTP server (STARTTLS, TLS or plain for
local relays) or a generic webhook that receives a JSON POST per alert. Each
channel picks which alerts it gets; "Send a test" checks the settings. Tokens
and webhook URLs are encrypted and never shown again (leave them empty when
editing to keep them; changing where they are sent, such as the ntfy server or
SMTP host, requires entering them again).

Gantry keeps one Docker event stream open per environment and raises:

| Alert | When |
| --- | --- |
| Container crashed | A container exits with a non-zero code without anyone stopping it (`docker stop`, compose down and Gantry's own actions don't count) |
| Out of memory | The kernel OOM killer hits a container |
| Unhealthy | A container's healthcheck turns unhealthy |
| Restart loop | A container dies 3 times within 10 minutes |
| Environment unreachable | Docker can't be reached for 2 minutes (and again when it's back) |
| Image update available | The periodic update check finds newer images (each update is announced once) |
| Auto-update result | A scheduled or manual auto-update run updated or failed to update something |

The same alert for the same container is sent at most every 10 minutes. Every
alert is listed under "Recent alerts" with its delivery result, for 30 days.

### Auto-update

**Auto-update** turns updates on per container (by name, so it survives
recreation) or via the label `gantry.auto-update=true`. Once a day at the set
time (server time zone; set `TZ` on the Gantry container), every environment's
opted-in running containers are checked against their registries and those
with a newer image are pulled and recreated with the same settings, one at a
time, with rollback on failure; containers pinned to a digest, built locally or
running Gantry itself are skipped. "Run now" does the same immediately. The
last run's results stay on the page, are recorded in the activity log (as
`auto-update`) and are sent to channels subscribed to auto-update results.

### Reverse proxy

**Proxy** (administrators) maps domains to container ports, per environment.

- **Built-in (Caddy)**: Gantry runs `caddy:2-alpine` as the container
  `gantry-proxy` (host ports 80/443 by default, configurable) on the
  `gantry-proxy` network, with certificates kept in the `gantry-proxy-data`
  volume. Each proxy host lists its domains, the target container and port, and
  a TLS mode: *Let's Encrypt* (public domain, DNS pointing at the host, ports
  80/443 reachable from the internet), *Self-signed* (Caddy's local CA, for LAN
  names) or *HTTP only*. Saving uploads a generated Caddyfile through the Docker
  API and runs `caddy reload`, so it also works for remote environments; Caddy
  rejects an invalid configuration and keeps serving the previous one (the
  error is shown on the page). Target containers are attached to the
  `gantry-proxy` network automatically and reached by name.
- **External proxy**: for Traefik, Nginx Proxy Manager or your own Caddy.
  Gantry attaches target containers to your proxy's Docker network and shows
  ready-to-paste config per host (Traefik labels, a Caddyfile block, an nginx
  `server`).
- **Off** removes the built-in proxy container (its certificate volumes stay).

Shortcuts: a container's page lists the domains proxied to it and has
**Expose via proxy**; deploying a template can create a proxy host for one of
its services (pick the service and port, a domain and the TLS mode).

### Environments: TLS and access

- TCP environments can use mutual TLS like `docker --tlsverify`: switch on
  "Use TLS" and paste or load `ca.pem`, `cert.pem` and `key.pem` (default port
  2376). The certificates are stored AES-256-GCM-encrypted with a key derived
  from `GANTRY_SECRET` (or `data/secret.key`); if that secret changes, enter
  them again. The private key is never shown again after saving.
- Administrators can use every environment. Standard users only see the
  environments granted to them (Users page, or an environment's Access
  dialog). New users and environments start without grants; existing standard
  users kept access to all existing environments when this was introduced.

### Kubernetes environments

Add a cluster under **Environments → Add environment → Kubernetes (API
server)**, either with

- the **API server URL**, a **bearer token** and the cluster's **CA
  certificate** (PEM; leave it empty if the API server has a publicly trusted
  certificate), or
- a pasted **kubeconfig**: the current context (or the one you name) gives the
  server, CA and credentials. Tokens and client certificates work; they must
  be embedded (`kubectl config view --raw --minify --flatten`). Credential
  plugins (`exec`, `auth-provider`: EKS, GKE, AKS/kubelogin, OIDC) can't run
  on the server and are rejected; use a service account token for those
  clusters.

Gantry checks the connection (`/version` and an authenticated discovery call)
before saving. Tokens, client keys and the CA are stored AES-256-GCM-encrypted
like Docker TLS keys and never sent to the browser. "Skip TLS verification" is
off by default; only use it for test clusters, since anyone on the network
path could then impersonate the API server and capture the token. The default
namespace is preselected on the list pages (the namespace picker is remembered
per environment).

A service account for Gantry (Kubernetes 1.24+):

```bash
kubectl -n kube-system create serviceaccount gantry
# Full access (needed for scale/restart/delete/apply/namespaces):
kubectl create clusterrolebinding gantry --clusterrole=cluster-admin --serviceaccount=kube-system:gantry
# ...or read-only access to one namespace:
#   kubectl -n my-app create rolebinding gantry-view --clusterrole=view --serviceaccount=kube-system:gantry
# A token (rotate it before it expires)...
kubectl -n kube-system create token gantry --duration=8760h
# ...or a long-lived one stored in a Secret:
kubectl -n kube-system apply -f - <<'YAML'
apiVersion: v1
kind: Secret
metadata:
  name: gantry-token
  annotations:
    kubernetes.io/service-account.name: gantry
type: kubernetes.io/service-account-token
YAML
kubectl -n kube-system get secret gantry-token -o jsonpath='{.data.token}' | base64 -d
kubectl -n kube-system get secret gantry-token -o jsonpath='{.data.ca\.crt}' | base64 -d   # CA certificate
```

Gantry can only do what the account's RBAC allows; pages it may not read show
the API's "forbidden" message. With a Kubernetes environment selected, the
sidebar shows the Kubernetes pages instead of the Docker ones; Docker-only
pages (containers, stacks, templates, topology, ...) say so instead of failing.
Registries apply to Docker environments only (clusters pull with their own
image pull secrets).

- Viewing (lists, pod logs) needs access to the environment, like Docker.
  Scaling, rollout restart, deleting pods/workloads, creating/deleting
  namespaces and applying manifests are admin-only and audited.
- **Apply manifest** uses server-side apply (`fieldManager=gantry`) into the
  chosen namespace; objects that name another namespace are refused, as with
  `kubectl apply -n`. "Force conflicts" (off by default) takes over fields
  owned by other managers; "Dry run" validates on the server without changes.
  Every object gets its own result; a failing one doesn't stop the rest.
- Secrets are listed with their keys only; values are dropped on the server.
- Kubernetes pages don't update live (no Docker events); reload to refresh.
  The metrics history, image update checks and live Docker events skip
  Kubernetes environments.

### Live updates and history

- Pages refresh themselves from Docker events, streamed as Server-Sent Events
  from `/api/events` (one Docker events connection per environment, shared by
  all tabs).
- Behind a reverse proxy, don't buffer `/api/events` and `/api/exec/*`
  (nginx: `proxy_buffering off`, or rely on the `X-Accel-Buffering: no`
  header) and allow read timeouts above 25 seconds.
- A background sampler records CPU, memory and running containers per
  environment for the dashboard's 1 h / 24 h / 7 d views.

## Security model

- `proxy.ts` sits in front of everything. Every `/api/*` route needs a valid
  signed session (anything else gets `401`, including unknown routes), and
  only `/api/health` is public. Pages without a session redirect to `/login`.
- Route handlers and Server Actions re-check the user against the database,
  so deleted users and role changes take effect immediately.
- Passwords are hashed with scrypt. Failed logins are limited per account
  (10 per 5 minutes, regardless of client address) and, with `TRUST_PROXY=true`,
  per client address too. Forwarding headers are ignored unless trusted.
- Standard users can view resources and start/stop/restart containers.
  Creating and removing things, and managing users and environments, is
  limited to administrators. Container environment variable values are
  shown to administrators only.
- The console (`/api/exec/*`) is admin-only. Sessions are bound to the user
  who opened them, use unguessable ids, are audited, and close when the page
  is left or nobody reads them for 20 seconds.
- A fresh instance can only be claimed with the setup token from the server
  log / data directory; it is deleted once the admin exists.
- Access to the Docker socket is equivalent to root on the host, and a
  cluster-admin token to the whole cluster. Keep Gantry on a trusted network
  or behind HTTPS.
