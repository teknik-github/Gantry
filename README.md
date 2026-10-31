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
- **Git stacks (GitOps)**: deploy a compose file from a Git repository (private
  ones with an encrypted token), redeploy on push via webhooks (GitHub, GitLab,
  Gitea/Forgejo, any CI) or by polling, with the deployed commit on the stack page
- **Topology**: interactive map of compose projects, containers, networks,
  volumes and `depends_on` relations
- Images (pull, remove, prune), volumes and networks (create, remove)
- **File browser** for containers (running, stopped or without a shell) and
  volumes: browse, download files and folders, upload (drag and drop), edit
  text files, create folders, delete; plus **log download** (streamed `.log`
  with timestamps, since/until, tail) and **log search** in the viewer
- **Private registries**: store logins (encrypted) for GHCR, GitLab, Docker Hub
  or your own registry; used for pulls, recreate, update checks and stacks
- **Image updates**: containers whose tag has a newer image in the registry
  get an "update" badge; update them one by one or in bulk
- **Vulnerability scanning**: scan images with [Trivy](https://trivy.dev) on
  the host that holds them; severity badges on the Images page, a findings
  view, a daily scan of images in use and alerts for new findings
- **Templates**: 35 ready-made stacks (databases, WordPress, Nextcloud,
  monitoring, Gitea, n8n, Keycloak, Ollama + Open WebUI, ...) plus your own
  templates from any compose file
- **Notifications**: alerts to Telegram, Discord, Slack, ntfy, email (SMTP) or any webhook
  when containers crash, run out of memory, turn unhealthy or restart-loop,
  when an environment is unreachable, and for image updates
- **Auto-update**: scheduled daily updates for the containers you choose
  (or label `gantry.auto-update=true`), rolled back on failure
- **Backups**: encrypted backups of all of Gantry's data (download, or daily
  to a directory with retention) and restore, across SQLite and MySQL
- **Reverse proxy**: serve containers under domain names with automatic HTTPS,
  through a built-in Caddy proxy or the proxy you already run
- **Bulk actions**: tick several containers, images, volumes or networks and
  start/stop/restart/pause/resume/kill or remove them at once
- Multiple Docker environments: local socket or TCP, optionally with mutual TLS,
  or a **remote host agent** that connects out to Gantry (hosts behind NAT or
  a firewall, no exposed Docker API); standard users only see the
  environments they were given
- **Kubernetes environments**: connect a cluster with a service account token
  or a kubeconfig; overview (nodes, namespaces, pods by phase), workloads
  (scale, rollout restart, delete), pods (status, followed logs, console,
  delete), services and ingresses, namespaces, ConfigMaps and Secrets (names
  and keys only), warning events, **Helm** (chart repositories, install,
  upgrade, rollback, uninstall with live output; values and manifest),
  **Edit YAML** with a diff of the server-side dry run, and **Apply manifest**
  (multi-document YAML, server-side apply); pages update live from Kubernetes
  watches
- Users: global `admin` / standard roles plus **per-environment roles**
  (viewer, operator, manager), and an activity log
- **Two-factor authentication** (TOTP authenticator apps, recovery codes),
  **single sign-on** (OpenID Connect) and personal **API tokens** for scripts
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

### Production checklist

The dashboard shows administrators a **Setup checks** card until these are
done (each item links to where it's fixed):

1. **HTTPS.** Don't expose port 3000 directly. The simplest way is Gantry's
   own proxy: on **Proxy** choose *Built-in (Caddy)* (ports 80/443), then open
   Gantry's container and use **Expose via proxy** with your domain, port
   3000 and *Let's Encrypt*. Keep `COOKIE_SECURE=auto` (cookies become
   `Secure` over HTTPS) and set `GANTRY_URL=https://your.domain` (needed for
   SSO). Then bind Gantry's own port to localhost only
   (`GANTRY_PORT=127.0.0.1:3000`) or drop the port mapping.
2. **TRUST_PROXY=true** once a proxy you control is in front and sets
   `X-Forwarded-For`, so login rate limits see real client addresses.
3. **Backups**: schedule a daily encrypted backup, ideally to a separate mount
   (`BACKUP_DIR`), and keep the passphrase outside Gantry.
4. **Two-factor authentication** for every administrator (Account), and SSO
   if you have an identity provider.
5. **Notifications**: at least one channel, subscribed to crashes,
   unreachable environments, failed backups and resource thresholds.
6. Keep `GANTRY_SECRET` (or `data/secret.key`) safe: it decrypts every stored
   credential.

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
a fresh SQLite database (single sign-on pointed at a fake OpenID provider that
`tests/e2e/sso.spec.ts` starts on the next port, `E2E_OIDC_PORT`), and runs the login suite first (it creates the admin
the other suites use). The Docker-backed suites (console, stacks, recreate,
topology, live updates, environments) create throwaway `gantry-test-*`
containers/networks/volumes labelled `gantry.e2e=true` and remove them
afterwards; they are skipped when Docker isn't reachable. Useful switches:

- `E2E_SKIP_BUILD=1` reuses the last `pnpm build` (handy on a slow machine:
  run `pnpm build` first, since the web server start times out after 5 minutes)
- `E2E_BASE_URL=http://host:port` targets a running, not-yet-set-up Gantry instead
- `E2E_PORT` changes the port (default 3100)

The agent suite (`tests/e2e/agent.spec.ts`) runs the agent as a
`gantry-test-a-agent` container with `--network host` and the host's Docker
socket, connecting to the test server on 127.0.0.1. It doesn't build the
Gantry image: it bind-mounts `agent/` into the stock `node:24-alpine` image and
runs the script with `node` (what the image's `agent` command does). It also
prints the tunnel's list latency and 50 MB download throughput next to the
local socket's.

The Git stack suite serves a private repository from the test process with
`git http-backend` over plain http on 127.0.0.1. The test server is started
with `GANTRY_TEST_ALLOW_HTTP_GIT=1`, which lets Gantry accept `http://` Git
URLs, and only for loopback hosts; never set it in production.

Unit/integration extras:

- The TLS tests need `openssl` and the Docker socket (they run a local mTLS
  proxy in front of it).
- `GANTRY_DOCKER_IT=1` also runs the recreate tests against real Docker.
- `GANTRY_TEST_TRIVY=1` runs a real Trivy scan of `alpine:3.10` through the
  mTLS proxy (`tests/integration/trivy.test.ts`); it pulls what is missing and
  downloads the database into the `gantry-test-s-trivy-cache` volume, removed
  afterwards unless `GANTRY_TEST_KEEP_TRIVY_CACHE=1`. The E2E suite
  (`tests/e2e/image-scan.spec.ts`) scans the same image through the UI; its
  server uses that volume too and removes it unless `E2E_KEEP_TRIVY_CACHE=1`.
- `GANTRY_TEST_MYSQL_URL=mysql://root:…@127.0.0.1:3307/x` runs the database
  tests on MySQL (`tests/integration/mysql.test.ts`: fresh install, upgrades
  from 005 and 013, column sizes and collations; and the user, 2FA, OIDC, API
  token and environment access tests). Each test creates and drops its own
  `gantry_test_*` database, so the user needs `CREATE`/`DROP DATABASE`; use a
  throwaway server, e.g.
  `docker run -d --name gantry-test-mysql -p 127.0.0.1:3307:3306 -e MYSQL_ROOT_PASSWORD=pw --tmpfs /var/lib/mysql mysql:8.4`.

E2E against MySQL: `E2E_DB=mysql E2E_MYSQL_URL=mysql://user:pass@host:port/db pnpm test:e2e`
starts the server with `DB_DRIVER=mysql` on that database. **Every table in it
is dropped first**, so point it at a throwaway database.

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
see below; it also tests the token form). The test workloads run `alpine:3`.
The Helm test installs a tiny local chart with the `helm` CLI when it is on the
PATH (with private Helm directories and the explicit kubeconfig), otherwise it
writes the release record Helm would. `tests/e2e/kubernetes-helm-edit.spec.ts`
(same variables; needs `helm` and `kubectl` on the PATH, no internet) serves a
chart repository from 127.0.0.1 and installs, upgrades, rolls back and
uninstalls a release through Gantry, edits a ConfigMap as YAML (diff and a
conflict) and checks that the ConfigMaps page updates live. `GANTRY_TEST_KUBECONFIG=…` also runs
`tests/integration/kubernetes.test.ts` (client, watches, exec, log follow)
against the same throwaway cluster.

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
| `BACKUP_DIR` | `$DATA_DIR/backups` | Where scheduled backups are written (mount another disk here) |
| `TRIVY_IMAGE` | `aquasec/trivy:0.76.1` | Scanner image for vulnerability scans (pulled on each environment when missing) |
| `TRIVY_CACHE_VOLUME` | `gantry-trivy-cache` | Named volume, on each environment, holding Trivy's vulnerability database |
| `TRIVY_TIMEOUT_MINUTES` | `20` | Longest a single scan (pull, export, scan) may take |
| `TRIVY_DB_REPOSITORY`, `TRIVY_JAVA_DB_REPOSITORY`, `TRIVY_SKIP_DB_UPDATE`, `TRIVY_SKIP_JAVA_DB_UPDATE`, `TRIVY_OFFLINE_SCAN`, `TRIVY_INSECURE` | | Passed on to the scanner container as is (database mirrors, offline use) |
| `FILES_UPLOAD_MAX_MB` | `512` | Largest file one upload may carry (file browser) |
| `FILES_EDIT_MAX_KB` | `1024` | Largest text file the file browser opens and saves in its editor |
| `FILES_LIST_MAX_ENTRIES` | `5000` | Entries shown per folder (the rest are counted) |
| `FILES_SCAN_MAX_MB` / `FILES_SCAN_TIMEOUT_SECONDS` | `512` / `30` | Limits for listing a folder of a stopped or shell-less container from Docker's tar archive |
| `FILES_HELPER_IMAGE` | `alpine:3` | Image of the short-lived containers that open volumes (needs `sh`, `stat`, `rm`; pulled when missing) |
| `FILES_HELPER_IDLE_SECONDS` | `120` | How long a volume helper is kept for the next operation before it is removed |
| `HELM_BIN` | `helm` on the `PATH` | The helm 3 CLI used for chart installs/upgrades/rollbacks (the Docker image includes a pinned, checksum-verified helm) |
| `HELM_MAX_OPERATIONS` | `4` | Helm installs/upgrades/rollbacks/uninstalls running at once on the server (1–64) |
| `GANTRY_BUILD_MAX_CONTEXT_MB` | `512` | Largest build context (uploaded archive or Git context) an image build accepts |
| `GANTRY_BUILD_TIMEOUT_MINUTES` | `60` | An image build (clone, build and push) is stopped after this long |
| `GANTRY_BUILD_CONCURRENCY` | `2` | Image builds running at once; more are refused until one finishes |
| `GANTRY_URL` | | Public URL of Gantry (e.g. `https://gantry.example.com`); the OIDC callback is `$GANTRY_URL/auth/oidc/callback`, and agents are told to connect here |
| `GANTRY_AGENT_IMAGE` | `gantry:latest` | Image named in the agent's `docker run` command |
| `GANTRY_AGENT_MAX_STREAMS` | `64` | Tunneled Docker connections per agent at once (4–1024) |
| `GANTRY_AGENT_QUEUE_SECONDS` | `30` | How long a Docker connection waits for a free tunnel stream when all are in use |
| `GANTRY_AGENT_HEARTBEAT_SECONDS` | `10` | Ping interval of agent connections; silent ones are dropped after 3.5 intervals |
| `OIDC_ISSUER` | | OpenID provider (issuer URL); single sign-on is off unless this and `OIDC_CLIENT_ID` are set |
| `OIDC_CLIENT_ID` / `OIDC_CLIENT_SECRET` | | Client registered at the provider (confidential client; the secret is optional for public clients, PKCE is always used) |
| `OIDC_REDIRECT_URL` | `$GANTRY_URL/auth/oidc/callback` | Callback URL, if it differs |
| `OIDC_SCOPES` | `openid profile email` | Requested scopes (`openid` is always added) |
| `OIDC_AUTO_CREATE` | `false` | `true`: the first SSO login of an unknown identity creates a standard user |
| `OIDC_ADMIN_GROUPS` | | Comma-separated groups whose members are administrators; when set, the role follows the claim on every SSO login |
| `OIDC_GROUPS_CLAIM` | `groups` | Claim holding the groups (ID token, or userinfo if absent there) |
| `OIDC_USERNAME_CLAIM` | `preferred_username` | Claim used for new usernames (then the email's local part, then the name) |
| `PASSWORD_LOGIN` | `all` | `admins`: with SSO configured, only administrators may use the password form (break-glass access) |

### MySQL

- **Version**: MySQL 8.0 or newer (tested with 8.4, the version in
  `docker-compose.yml`), InnoDB tables, a database whose default character set
  is `utf8mb4` (MySQL 8's default). Strict SQL mode (the default) is fine.
- **Privileges**: migrations run at startup, so the user needs `CREATE`,
  `ALTER`, `INDEX` and `REFERENCES` on Gantry's database besides
  `SELECT`/`INSERT`/`UPDATE`/`DELETE`. The compose `mysql` service's
  `MYSQL_USER` has all privileges on `MYSQL_DATABASE`.
- **Upgrading**: migration `014_mysql_columns` (MySQL only; nothing changes on
  SQLite) widens columns that were too small for what the forms accept (TLS
  and Kubernetes credentials, the auto-update history, proxy hosts with many
  domains) and makes OIDC identities, auto-update container names and webhook
  ids case-sensitive. It rebuilds a few small tables when Gantry starts; back
  up the database before upgrading, as with any migration.
- **Case-insensitive names**: MySQL's default collation
  (`utf8mb4_0900_ai_ci`) ignores case, so on MySQL **usernames** and **custom
  template titles** are case-insensitive: `Alice` and `alice` are the same
  account (either spelling signs in, and a second one can't be created), and
  two templates can't differ only in case. On SQLite they are distinct. Login
  rate limits treat usernames case-insensitively on both. Lists sorted by name
  ignore case on MySQL and put uppercase first on SQLite. Registry addresses,
  stack names and proxy domains are stored in lowercase, so they behave the
  same on both. OIDC subjects, container names and webhook ids are always
  compared exactly.

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

### Git stacks

- **New stack → Git repository**: an `https://` URL, a branch, tag or full
  commit id, and the compose file's path in the repository (default
  `docker-compose.yml`; `compose.yaml`, `deploy/prod.yml` … work too). The ref
  is cloned right away, so a wrong URL, ref, path or token is reported before
  anything is saved.
- The checkout lives in `DATA_DIR/stacks/<envId>-<name>/repo/`, and compose
  runs with `-f repo/<path>`, so **relative paths in the compose file
  (`build:`, `env_file:`, bind mounts) resolve inside the repository** (still
  inside Gantry's container, see above). Gantry's `.env` for the stack stays
  editable in the UI and lives next to the checkout (`--env-file`), not in the
  repository; use it for `${VAR}` substitution (`environment: KEY: ${KEY}`).
- Updates are shallow fetches of the ref followed by a forced checkout of the
  commit: tracked files are reset, untracked files (e.g. data folders) stay.
  Submodules and Git LFS files are not fetched.
- **Pull & redeploy** fetches the ref, then runs `docker compose pull` and
  `up -d`. If neither the commit nor the `.env` changed since the last
  successful deploy it does nothing; **Force redeploy** runs it anyway.
  **Deploy** uses the current checkout without fetching. The page shows the
  deployed commit (short id, message, author and date).
- Private repositories: a username and an access token (GitHub fine-grained
  token with *Contents: read*, GitLab `read_repository`, Gitea/Forgejo
  `read:repository`). The token is encrypted at rest (AES-GCM, bound to the
  stack), never sent back to the browser, and kept out of git's argv, the
  environment, the stored URL and `.git/config`: for each git command it is
  written to a file in a private temp dir (0700/0600) that a credential helper
  `cat`s, configured through `GIT_CONFIG_*` variables, and removed afterwards.
  git only sends it when the server asks for credentials. Changing the host
  of the URL requires entering the token again.
- git runs with a minimal environment (no system/global git config, no
  credential helpers from the host, prompts off, hooks off, https only), a
  5-minute fetch timeout, a stall timeout and capped output.
- **Webhooks** (per stack, off by default): *Enable webhook* creates a URL
  `/api/webhooks/stacks/<random id>` and a secret that is shown once (stored
  encrypted; *Regenerate secret* rotates it). The stack page has setup steps
  per provider:
  - GitHub: content type `application/json`, the secret, "Just the push
    event" (verified with `X-Hub-Signature-256`, HMAC-SHA256 of the body).
  - GitLab: the secret as *Secret token* (`X-Gitlab-Token`), push events
    (and tag push events for tags).
  - Gitea / Forgejo: the secret (`X-Gitea-Signature` / `X-Forgejo-Signature`,
    HMAC-SHA256), push events.
  - Anything else (CI): `curl -X POST -H "X-Gantry-Token: <secret>" <url>`
    (or `Authorization: Bearer`, or `?token=` — avoid the query string, it ends
    up in access logs). An optional JSON body `{"ref": "refs/heads/main"}` is
    checked like a push.
  Signatures and tokens are compared in constant time. Only pushes to the
  stack's branch (or tag) redeploy; other refs, branch deletions and other
  events are acknowledged and ignored. Deliveries are answered at once (`202`)
  and the redeploy runs in the background; concurrent deliveries are merged
  (one run at a time per stack, at most one queued behind it).
- **Polling** (per stack, off by default): *Check for new commits every N
  minutes* asks the remote (`git ls-remote`) and pulls & redeploys when the
  ref moved. Busy stacks are skipped until the next check; a commit that
  failed to deploy is not retried until a newer one appears.
- Deploys of Git stacks (manual, webhook or polling) raise a **Git stack
  deployed** notification (success or failure) for channels subscribed to it.
- Creating and editing Git stacks, and managing webhook secrets, is
  admin-only and audited, as is every webhook delivery (accepted, ignored or
  rejected, without the secret).

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

### Files and logs

The container page has a **Files** tab, and **Volumes → Browse** opens
`/volumes/<name>` with the same browser: breadcrumbs (or type a path), name,
type (symbolic links with their target), size, mode, owner and modification
time; download a file or a whole folder (`.tar`), upload files (button or drag
and drop; asks before replacing), create folders, delete, and view/edit text
files up to `FILES_EDIT_MAX_KB` (binary files are detected and offered as a
download). Saving keeps the file's owner and mode; new files and folders
belong to root (644 / 755).

How it works:

- **Listing** uses `stat` through `docker exec` when the container runs and
  has a shell (fast, any folder size). Stopped, paused or distroless
  containers are listed from the headers of Docker's tar archive of the
  folder (`GET /containers/{id}/archive`), skipping file bodies. Docker still
  sends everything below the folder, so big trees take a while and listing
  stops after `FILES_SCAN_MAX_MB` / `FILES_SCAN_TIMEOUT_SECONDS` with a
  notice. Measured on a busy 4-CPU host: `/usr` of a stopped `node:24-slim`
  (221 MB, 6,483 entries) took 13.7 s from the archive; `stat` through exec
  lists `/usr/bin` of the running container in ~0.15 s.
- **Downloads, uploads, edits and new folders** use the archive API, so they
  work in stopped containers too. Everything is streamed (no size limit for
  downloads; uploads up to `FILES_UPLOAD_MAX_MB`, sent as the raw request body
  to `PUT /api/uploads/files`, outside `proxy.ts` because it would buffer the
  body). **Delete** runs `rm` in the container, so it needs a running
  container with `rm`; otherwise it is disabled with the reason.
- **Volumes** are opened by a helper container (`FILES_HELPER_IMAGE`, label
  `gantry.helper=files`, named `gantry-helper-files-…`, no network, read-only
  root filesystem) with the volume mounted read-only, or read-write for
  changes. A helper is reused for `FILES_HELPER_IDLE_SECONDS` and then
  removed; helpers also remove themselves after 6 hours (`sleep` with
  AutoRemove), Gantry sweeps leftovers by label at startup and every 10
  minutes, and removing the volume in Gantry removes its idle helpers first.
  Every path component is checked inside the helper first: the browser never
  follows a symbolic link inside a volume (links can be deleted, not entered
  or written through). The volume page lists the containers that mount it and
  asks before the first change while it is in use.
- Paths are normalized (no `..` above the root, no NUL bytes) and names are
  single path components.

The log viewer has **search** (case-insensitive, highlighted, match count,
next/previous with Enter / Shift+Enter, "only matching lines") and
**Download**: the whole log (or the last N lines, or a since/until window,
with or without timestamps) streamed as `<container>-<time>.log`.

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

### Vulnerability scanning

The Images page has a **Vulnerabilities** column with counts per severity
(Critical / High / Medium / Low) for scanned images. **Scan** (row button, or
select several images) queues a scan; scans run in the background, one at a
time per environment, and the badges update by themselves. The badges link to
the findings: vulnerability id, package, installed and fixed version,
severity and title, with a severity filter, a "fixable only" switch and a
search, plus when the image was scanned, with which Trivy version and
vulnerability database. A container's page shows the scan of its image.
Viewers see results; scanning needs the operator role.

How a scan works: Gantry runs [Trivy](https://trivy.dev) (`TRIVY_IMAGE`,
pinned to a release) as a short-lived container **on the environment that
holds the image**, using only the Docker API, so remote TCP/TLS environments
work like the local socket and the scanner never gets the Docker socket:

1. the scanner image is pulled on that environment if missing (progress is
   shown in the column), and the `TRIVY_CACHE_VOLUME` volume keeps Trivy's
   vulnerability database between scans;
2. the image is exported (`GET /images/{id}/get`, i.e. `docker save`) and
   streamed straight into the created scanner container (`PUT /archive`),
   where it unpacks as an OCI image layout that `trivy image --input` reads.
   Nothing is buffered in Gantry, but the image does travel from the daemon
   to Gantry and back, so on a remote environment a scan costs about twice
   the image size in network traffic;
3. Trivy runs with `--scanners vuln`; the JSON report is read back, parsed,
   and the container is always removed (scanner containers are labelled
   `gantry.scanner=true`; leftovers from a restart are swept at startup and
   hourly).

Measured on a busy 4-CPU host (Docker 29, containerd image store) with the
database already cached: `alpine:3.10` (3 MB) took 25 s (5 s export and copy,
18 s Trivy) and up to 90 s when the host was saturated; `postgres:17-alpine`
(118 MB) took 90 s (40 s export and copy, where a plain `docker save` takes
20 s, and 40 s Trivy). The first scan on an environment also downloads the
database from `mirror.gcr.io/aquasec/trivy-db` (then `ghcr.io`): 2 to 3
minutes here, so that first scan took 4.5 minutes; Trivy refreshes it at
most once a day.

Only the latest scan of each image is kept, with up to 3,000 findings (the
most severe; the counts include all of them). A failed scan keeps the
previous results and shows its error.

**Daily scan and alerts** (administrators, card on the Images page): scan the
images that containers use on every environment once a day at a set time, and
pick the lowest severity that raises a **Vulnerabilities found** alert
(default Critical). An alert only names findings the previous scan of that
image didn't have, so a daily scan doesn't repeat yesterday's alert; the
first scan of an image reports everything at or above the threshold.

**Offline and air-gapped hosts**: when the database can't be downloaded the
scan fails with an explanation. Either point `TRIVY_DB_REPOSITORY` (and
`TRIVY_JAVA_DB_REPOSITORY`) at a reachable mirror of the OCI artifacts, or
fill the cache volume yourself (`trivy image --download-db-only
--cache-dir /cache`, then copy that directory into the volume, mounted at
`/root/.cache/trivy`) and set `TRIVY_SKIP_DB_UPDATE=true` and
`TRIVY_SKIP_JAVA_DB_UPDATE=true`. Push the scanner image to a registry the
environment can reach and set `TRIVY_IMAGE` to it (stored registry logins are
used for the pull).
### Image builds, tag and push

**Images → Build image** (`/images/build`, managers) builds on the current
environment with its Docker daemon, from one of three sources:

- **Dockerfile**: written in the editor, with up to 20 small extra files next
  to it for `COPY` (1 MB together);
- **Upload archive**: a `.tar` or `.tar.gz` of the build context, streamed to
  Docker as it is received and never stored (`GANTRY_BUILD_MAX_CONTEXT_MB`);
- **Git repository**: URL, branch/tag/commit, context directory and Dockerfile
  path, cloned shallowly with the Git stacks code (https only, an optional
  username and token used for this clone only and never stored, redacted from
  the output). `.git` is left out of the context.

Options: one or more tags, build arguments, labels, a target stage, no cache,
always pull base images, and push after build. Every stored registry login is
sent with the build (`X-Registry-Config`), so `FROM` can use private images.
Don't pass secrets as build arguments: they are visible in the image history
and in Gantry's build history.

The output streams live (the response of `POST /api/images/build` is JSON
lines) and ends with the image id and tags, or Docker's error. **Cancel build**
closes that request, and so does leaving the page or closing the tab: Gantry
then closes its connection to Docker, which stops the build and kills the
running step's container. Builds run with the classic builder (`/build`
`version=1`, whose stream carries the output, errors and image id), stop after
`GANTRY_BUILD_TIMEOUT_MINUTES`, and at most `GANTRY_BUILD_CONCURRENCY` run at
once.

The last 100 builds of each environment are kept with who started them, the
source (without credentials or the archive), tags, outcome, duration, image id
and the end of their output (512 KB). **Log** shows it; **Rebuild** fills the
form again from the editor or Git source (enter a Git token again for private
repositories).

On the Images page, **Tag** adds a name to an image and **Push** uploads one of
its tags with the login stored under Registries for that tag's registry
(`localhost:5000/team/app:1` → `localhost:5000`), with live progress. A refused
login, or a registry without a stored login, says so and links to Registries.
Building, tagging and pushing need the manager role and are audited
(`image.build`, `image.tag`, `image.push`).

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
| Backup failed | A scheduled backup couldn't be written |
| High CPU or memory | A container's CPU (100% = one core) or memory (% of its limit), or all containers' memory on a host, stays at or above the thresholds for the set number of minutes |

Resource thresholds are set under **Notifications → Resource thresholds**
(empty = off) and checked on every metrics sample (`METRICS_INTERVAL_SECONDS`);
each one repeats at most hourly while it stays high.

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

### Backups and restore

**Backups** (administrators) holds everything Gantry stores — environments,
users (with 2FA and API tokens), stacks and their Git settings, templates,
registries, notification channels, proxy hosts, settings, history — plus the
secret that seals the encrypted values (TLS keys, cluster and Git
credentials, registry passwords, 2FA secrets, notification settings). It does
not contain containers, images or volumes: back those up with Docker's own
tools. Stack folders are rewritten from the database on the next deploy.

- A backup is a `.gbk` file: gzipped JSON encrypted with AES-256-GCM under a
  key derived from your passphrase (scrypt; at least 12 characters). Without
  the passphrase it can't be opened, and Gantry can't recover it.
- **Download** one at any time, or schedule a **daily backup** (time in the
  server's time zone) written to `BACKUP_DIR` with the newest *N* kept. The
  scheduled passphrase is stored encrypted; failures are sent to channels
  subscribed to "Backup failed". Scripts can take backups with an
  administrator's API token: `curl -H "Authorization: Bearer gtk_…" -H
  "Content-Type: application/json" -d '{"passphrase":"…"}' -o gantry.gbk
  https://gantry.example.com/api/backup`.
- **Restore** replaces all data with the backup's in one transaction and
  signs everyone out. Backups are database-independent, so a SQLite backup
  restores into MySQL and the other way round (create the first administrator
  with `/setup`, then restore). A backup from a newer Gantry is refused. If the
  backup was made with another secret, `DATA_DIR/secret.key` is replaced and
  Gantry must be restarted; with `GANTRY_SECRET` set, set it to the backup's
  value first.

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
  dialog), with a role per environment (see [Roles](#roles-and-permissions)).
  New users and environments start without grants; existing standard users
  kept access to all existing environments when this was introduced, and
  those grants became `operator` when roles were added (what they allowed).
  Promoting a user to administrator drops their grants, so a later demotion
  starts from no access.

### Remote hosts: the Gantry agent

For a Docker host behind NAT or a firewall, or one where you'd rather not
expose the Docker API or set up TLS: run a small agent container on it. The
agent connects **out** to Gantry, and Gantry manages the host through that
connection. Nothing listens on the remote host.

**Setup.** On **Environments**, click **Add agent** and give it a name. Gantry
creates the environment and shows an enrollment key, **once**, with a
ready-to-copy command (the key is stored only as a SHA-256 hash):

```bash
docker run -d --name gantry-agent --restart unless-stopped --user root \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -e GANTRY_URL=https://gantry.example.com \
  -e GANTRY_AGENT_KEY=gak_7_… \
  gantry:latest agent
```

The agent is a dependency-free Node.js script in the Gantry image
(`agent/gantry-agent.mjs`); `agent` as the command runs it instead of Gantry.
`--user root` lets it open the Docker socket (alternatively
`--group-add $(stat -c %g /var/run/docker.sock)`). The dialog waits until the
agent connects. The environment then shows connected/last seen, the agent
version, the host's name and Docker version and the address it connects from
(`X-Forwarded-For` behind a proxy). The key icon on its row **rotates the
key**: the old key stops working and the connected agent is dropped at once;
run the agent again with the new key. Deleting the environment drops it too.
Set `GANTRY_URL` for Gantry so the command names the address agents should
use; otherwise it is the one your browser used.

Agent settings: `GANTRY_URL`, `GANTRY_AGENT_KEY`, `GANTRY_AGENT_CA` (PEM text,
or a file path, of a CA to trust for Gantry's certificate),
`GANTRY_AGENT_INSECURE=1` (allow plain `http://` to a non-loopback address),
`DOCKER_SOCKET` (default `/var/run/docker.sock`), `GANTRY_AGENT_DEBUG=1` (log
every tunneled connection). The agent logs connects, disconnects with the
reason, refused keys and its reconnect delay; `docker logs gantry-agent`.

**Serve Gantry over HTTPS** when agents connect across networks: the key and
all Docker traffic (which is root on that host) go through this connection.
The agent refuses `http://` except to a loopback address unless
`GANTRY_AGENT_INSECURE=1` is set, and verifies Gantry's certificate (system
CAs, or `GANTRY_AGENT_CA`).

**How it works.** Plain HTTP, no WebSockets (Next.js route handlers can't
upgrade connections), through any reverse proxy that streams responses:

- The agent holds one long `GET /api/agent/connect` (authenticated with the
  key). Its response body is a stream of frames from Gantry. Frames are
  binary: type, stream id, length, then the payload. Types are HELLO, OPEN,
  DATA, END, RESET, WINDOW, PING, PONG and GOAWAY (`lib/agent/protocol.ts`).
- Frames to Gantry go in `POST /api/agent/upstream` batches (up to 1 MB, one
  at a time, numbered; authenticated with a per-session secret from HELLO).
- Each Docker connection Gantry makes is one tunneled stream. Per-stream
  windows (1 MB) give flow control both ways, so a slow reader pauses the
  writer instead of filling memory.
- Gantry pings every 10 s. Either side drops a connection that stays silent
  for 35 s, and the agent reconnects with exponential backoff and jitter
  (slowly, every 5 minutes, once its key was refused).
- In Gantry, every connected agent gets a Unix socket (`0600` in
  `$DATA_DIR/agent-sockets`, `0700`) that leads into its tunnel. The Docker
  API client connects there like to a local socket, so every feature works
  unchanged: lists, inspect, logs, events, exec consoles, stats and metrics,
  pulls with progress, file browser and archives, image build/push and Trivy
  scans. `docker compose` (stacks) gets `DOCKER_HOST=unix://…` pointing at
  that socket.

**Limits and differences.**

- **Single Gantry replica.** Tunnels live in the memory of the process the
  agent connected to; run one Gantry instance (as usual with SQLite).
- At most `GANTRY_AGENT_MAX_STREAMS` (64) tunneled connections per agent at
  once; more wait for a free one (up to `GANTRY_AGENT_QUEUE_SECONDS`, 30 s)
  and then fail with a clear error. Every open event stream, console and
  `docker compose` run holds one or more.
- As with TCP environments, a stack's relative bind mounts (`./data:/data`)
  name paths on the Docker host, not files next to the compose file in
  Gantry, and **Import** of stacks started outside Gantry only works for the
  local socket.
- A Trivy scan streams the image out of the host and back in through the
  tunnel, so large images take longer over slow links.
- Gantry refuses to stop, remove or recreate the agent's own container through
  the agent (it would cut its own connection), like its own container.
- Measured on this project's test host (agent and Gantry on the same
  machine, so this is the tunnel's overhead, not a WAN): MEASUREMENTS.

### Roles and permissions

Global roles: **administrators** manage Gantry itself (users, environments,
registries, notifications, templates, the auto-update schedule, the activity
log) and have every right in every environment. **Standard users** only work
in environments they were given, with one of these roles each:

| | viewer | operator | manager |
| --- | :-: | :-: | :-: |
| Lists, details, dashboard, resource usage, live updates | ✓ | ✓ | ✓ |
| Start / stop / restart / pause / kill containers, rollout restart (Kubernetes) | | ✓ | ✓ |
| Container and pod logs (view, search, download), image update checks, vulnerability scans | | ✓ | ✓ |
| Browse and download container and volume files | | ✓ | ✓ |
| Upload, edit, create folders, delete files | | | ✓ |
| Create / remove / prune containers, images, volumes, networks | | | ✓ |
| Build, tag and push images, build history | | | ✓ |
| Container environment variable values, edit & recreate, pull & recreate, console | | | ✓ |
| Stacks (create, edit, deploy, start/stop, delete), deploy templates | | | ✓ |
| Proxy, per-container auto-update | | | ✓ |
| Kubernetes: scale, delete, namespaces, apply manifests | | | ✓ |
| Import external compose projects, save a stack as template, users, environments, registries, notifications, auto-update and vulnerability scan schedules | | | admins |

Every Server Action and route handler checks the role for the **current**
environment on the server (`lib/server/action.ts` `authorize()`,
`lib/server/api-auth.ts`); hiding buttons is only a convenience. Pages send
the id of the environment they were rendered for, and an action is refused
("switched in another tab") when the selected environment changed since.

### Two-factor authentication

On the Account page, *Set up two-factor* asks for the password, shows a QR
code (and the key) for any TOTP app (SHA-1, 30 s, 6 digits) and turns on once
a code is confirmed. Ten one-time recovery codes are shown once (stored as
SHA-256 hashes); they can be regenerated with password + code. The secret is
stored encrypted and never sent again. Login then has a second step: a code
(one step of clock drift either way, each step accepted once) or a recovery
code, rate-limited like passwords. Turning it off needs the password and a
code; administrators can reset a user's 2FA on the Users page (audited, signs
the user out everywhere). SSO logins skip it: the identity provider handles MFA.

### Single sign-on (OpenID Connect)

Set `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET` and `GANTRY_URL`,
and register `$GANTRY_URL/auth/oidc/callback` as redirect URI at the
provider (Keycloak, Authentik, Entra ID, Google...). The login page then shows
*Sign in with SSO*: authorization code flow with PKCE (S256), `state` and
`nonce`, endpoints from `/.well-known/openid-configuration`, and the ID token
verified against the provider's JWKS (issuer, audience, expiry, nonce).

- Users are linked by issuer + subject only, never by username or email. With
  `OIDC_AUTO_CREATE=true` an unknown identity gets a new standard user (a
  free username from the claims, no password); otherwise it is refused.
  Existing local users link their account themselves on the Account page
  (*Link SSO account*, while signed in).
- Administrator rights come only from `OIDC_ADMIN_GROUPS`: when set, the role
  follows the groups claim at every SSO login (the last administrator is never
  demoted). Environment roles are still granted in Gantry.
- `PASSWORD_LOGIN=admins` reserves the password form for local administrators,
  as break-glass access when the provider is down; everyone else must use SSO.

### API tokens

Personal tokens for scripts, created on the Account page (name, expiry 30/90/365
days or never). The token (`gtk_` + 43 characters) is shown once; only its
SHA-256 hash is stored, with the last use. Tokens act with the user's current
permissions on `/api/*` route handlers only; they never open pages or run
Server Actions, and the console refuses them. Revoked or expired tokens get
`401`. Pick the environment with `X-Gantry-Environment: <id>` (default: the
first one the user may use).

```bash
TOKEN=gtk_...
# Containers of an environment (read-only JSON; any role)
curl -H "Authorization: Bearer $TOKEN" -H "X-Gantry-Environment: 1" https://gantry.example.com/api/v1/containers
# Live CPU/memory of running containers (any role)
curl -H "Authorization: Bearer $TOKEN" https://gantry.example.com/api/stats
# Recorded usage history: range=1h|24h|7d (any role)
curl -H "Authorization: Bearer $TOKEN" "https://gantry.example.com/api/metrics?range=24h"
# Docker events as Server-Sent Events (any role)
curl -N -H "Authorization: Bearer $TOKEN" https://gantry.example.com/api/events
# Last 200 log lines of a container (operator or manager)
curl -H "Authorization: Bearer $TOKEN" "https://gantry.example.com/api/containers/<id>/logs?tail=200"
# Whole log as a file, streamed (since/until: Unix seconds; tail: lines or "all")
curl -OJ -H "Authorization: Bearer $TOKEN" "https://gantry.example.com/api/containers/<id>/logs/download?timestamps=1"
# A folder listing, a file, or a folder as tar (operator or manager; ?volume=<name> for volumes)
curl -H "Authorization: Bearer $TOKEN" "https://gantry.example.com/api/files/list?container=<id>&path=/etc"
curl -OJ -H "Authorization: Bearer $TOKEN" "https://gantry.example.com/api/files/download?container=<id>&path=/etc/hosts"
# Build from a Git repository, streaming JSON lines (manager)
curl -N -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" https://gantry.example.com/api/images/build \
  -d '{"source":{"kind":"git","url":"https://github.com/org/app.git","ref":"main"},"options":{"tags":"app:1"}}'
# Push a tag with the stored registry login (manager)
curl -N -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" https://gantry.example.com/api/images/push \
  -d '{"reference":"registry.example.com/team/app:1"}'
```

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
  Scaling, deleting pods/workloads, creating/deleting namespaces, applying
  manifests, editing YAML and Helm operations need the manager role (rollout
  restart: operator) and are audited.
- **Apply manifest** uses server-side apply (`fieldManager=gantry`) into the
  chosen namespace; objects that name another namespace are refused, as with
  `kubectl apply -n`. "Force conflicts" (off by default) takes over fields
  owned by other managers; "Dry run" validates on the server without changes.
  Every object gets its own result; a failing one doesn't stop the rest.
- Secrets are listed with their keys only; values are dropped on the server
  (live updates watch ConfigMaps and Secrets as metadata only). Only
  administrators open a Secret in **Edit YAML**, which shows its data.
- **Edit YAML** (workloads, services, ingresses, ConfigMaps, Secrets): the
  editor shows the live object without `status` and server-managed metadata.
  **Review changes** sends the edited object as a server-side dry run
  (`PUT …?dryRun=All`, strict field validation) and shows a line diff of the
  result against the live object, so defaults and admission changes are
  visible before anything is stored. **Apply changes** replaces the object at
  the `resourceVersion` the editor was loaded at: if anyone changed it in the
  meantime the API answers 409 and Gantry shows a conflict (load the latest
  version and redo the change) instead of overwriting their change. Fields
  deleted in the editor are removed (it is a replace, like `kubectl replace`).
- **Live updates**: Gantry watches pods, deployments, stateful sets, daemon
  sets, services, ingresses, events, namespaces, ConfigMaps and Secrets (the
  last two as metadata only; Helm pages follow Secrets) with one watch per type and
  environment, shared by every open tab, closed shortly after the last tab
  leaves, and refreshes the pages that show what changed. Watches resume from
  the last resource version, follow bookmarks, re-list after "410 Gone" and
  reconnect with backoff. Credentials that may not watch cluster-wide fall back
  to the environment's default namespace. The metrics history and image update
  checks skip Kubernetes environments.
- **Pod logs** are followed as they are written (one API connection per open
  log view, closed when the view is closed or "Follow" is turned off; at most
  64 at once). "Previous" shows the last instance of a restarted container;
  the download button saves the whole log (up to 20 MB).
- **Console**: administrators can open a shell in a container of a running pod
  (`kubectl exec` over a WebSocket to the API server, `v5.channel.k8s.io` or
  `v4.channel.k8s.io`), audited like Docker consoles. The account needs RBAC
  `create` on `pods/exec` (and `get` on `pods/exec` for older clusters).
- **Helm releases** are listed from Helm 3's release records (Secrets of type
  `helm.sh/release.v1`): chart, version, app version, status and history.
  Administrators see a release's user-supplied values, manifest and notes
  (they may contain secrets).
- **Helm install / upgrade / rollback / uninstall** run the real `helm` CLI
  (`HELM_BIN`, else `helm` on the `PATH`; the Docker image ships helm
  v3.19.0, pinned and SHA-256-verified per architecture) and need the manager
  role. **Install chart** picks a chart from a **chart repository** (versions
  from `helm search repo --versions`) or an `oci://` reference, a release
  name and namespace (optionally created), and values in a YAML editor
  prefilled with the chart's defaults (`helm show values`); `--wait`,
  `--atomic` and `--timeout` are options. The release page adds **Upgrade**
  (another version and/or values; administrators edit the complete values,
  prefilled with the current ones, others keep them with
  `--reset-then-reuse-values`), **Roll back** to a chosen revision and
  **Uninstall** (hooks run). Command output is streamed live to whoever
  started the operation; NOTES are hidden for non-administrators.
  - Credentials: each helm command gets a fresh private temp directory
    (`mkdtemp`, mode 0700, files 0600) with a kubeconfig generated from the
    environment's stored token or client certificate (and CA / skip-verify),
    plus a `repositories.yaml` or OCI registry config holding only the
    repository login it needs. Nothing secret is passed in arguments or
    environment variables, the directory is deleted when the command ends,
    and output is redacted (tokens, keys, passwords, anything key-like).
  - Isolation: helm runs with an environment built from scratch (no
    `GANTRY_SECRET`, database settings or the server's `KUBECONFIG`), `HOME`
    in the temp directory, plugins disabled, and `HELM_CONFIG_HOME`,
    `HELM_CACHE_HOME` and `HELM_DATA_HOME` under `$DATA_DIR/helm/` (config,
    cache with the downloaded repository indexes, data).
  - Limits: one operation per release at a time (a second one is refused),
    at most `HELM_MAX_OPERATIONS` at once, a hard kill (SIGTERM, then SIGKILL
    of the process group) 2 minutes after the chosen `--timeout` (1–30
    minutes), 90 s for searches and `helm show values`, values up to 512 KB,
    512 KB of output kept per operation for 30 minutes. If Gantry restarts
    during an operation, helm is stopped with it and the release may stay
    `pending-*`; roll it back from the release page.
  - **Chart repositories** (administrators, like registry logins: they apply
    to every cluster) are index repositories (`https://`; plain `http://`
    without credentials, or to loopback) whose index is downloaded when they
    are added, or `oci://` registry paths. Optional username/password are
    stored AES-256-GCM-encrypted. Typed `oci://` references use the login of
    a matching OCI repository; for non-administrators they must lie under an
    added OCI repository (Gantry won't contact arbitrary registries for them).
  - Without the helm CLI, install/upgrade/rollback are unavailable and
    uninstall falls back to deleting the manifest's objects and the release
    records directly (like `helm uninstall --no-hooks`).

### Live updates and history

- Pages refresh themselves from Docker events (or Kubernetes watches),
  streamed as Server-Sent Events from `/api/events` (one Docker events
  connection or one set of watches per environment, shared by all tabs).
- Behind a reverse proxy, don't buffer `/api/events`, `/api/exec/*`,
  `/api/kubernetes/pods/*/logs` and `/api/kubernetes/helm/operations/*`
  (nginx: `proxy_buffering off`, or rely on the `X-Accel-Buffering: no`
  header) and allow read timeouts above 25 seconds.
- A background sampler records CPU, memory and running containers per
  environment for the dashboard's 1 h / 24 h / 7 d views.

## Security model

- `proxy.ts` sits in front of everything. Every `/api/*` route needs a valid
  signed session or a well-formed API token (anything else gets `401`,
  including unknown routes), and only `/api/health` is public — plus `POST`
  (only) to exactly `/api/webhooks/stacks/<32-character id>`, which
  authenticates each delivery with the stack's webhook secret, refuses bodies
  over 1 MB, is limited to 30 deliveries per minute per webhook and audits
  every delivery. Pages without a session redirect to `/login`; `/auth/*` (SSO
  and clearing stale cookies) is reachable without one.
- One route skips `proxy.ts`: `POST /api/images/build/upload` (build context
  archives). Next buffers the body of every request that goes through proxy
  in memory and cuts it at 10 MB, so this route streams the archive to Docker
  instead and makes proxy's checks itself: a valid browser session (no API
  tokens), the manager role, same-origin requests only, and a custom header
  that cross-site forms can't send.
- Route handlers and Server Actions re-check the user against the database,
  so deleted users and role changes take effect immediately. API tokens are
  only honoured on `/api/*` route handlers: `proxy.ts` marks such requests
  with a header derived from the secret (stripping any copy the client sent)
  and Server Actions are never token-authenticated, so the cookie's SameSite
  protection and Next's origin check still guard every mutation.
- Sessions carry a per-user version; *Sign out everywhere*, changing or
  resetting a password, enabling/disabling/resetting 2FA and changing a role
  bump it, which ends every other session (and open consoles) at once.
- Passwords are hashed with scrypt, at most two verifications run at once
  (excess attempts are refused), so a flood of logins can't exhaust the CPU.
  Failed logins are limited per account (10 per 5 minutes, regardless of
  client address) and, with `TRUST_PROXY=true`, per client address too.
  A browser that completed a login before holds a signed device cookie and
  counts against its own bucket, so someone hammering an account can't lock
  its owner out. Failed attempts are audited once per window (and never with
  a username that doesn't exist, which may be a mistyped password).
- Two-factor codes: 5 failures per 5 minutes per account, constant-time
  comparison, each time step accepted once. The state between password and
  code is a signed 5-minute cookie, not a session.
- Permissions per environment: see [Roles and permissions](#roles-and-permissions).
  Container environment variable values are shown to managers and
  administrators only.
- The console (`/api/exec/*`) needs the manager role in the environment it
  runs in, re-checked on every request; it refuses API tokens. Sessions are
  bound to the user who opened them, use unguessable ids, are audited, close
  when the page is left or nobody reads them for 20 seconds, and are closed
  when the user's role or access changes.
- Files may hold secrets: browsing and downloading container and volume
  files needs the operator role, changing them the manager role; downloads,
  uploads, edits, new folders and deletes are audited. Uploads
  (`/api/uploads/*`) bypass `proxy.ts` so bodies stream instead of being
  buffered; the handler itself requires a same-origin browser session (no API
  tokens), the manager role and the environment the page showed.
- The "at least one administrator" rule is enforced atomically (row locks on
  MySQL), so two admins demoting or deleting each other can't leave none.
- `next=` after login only accepts same-origin paths (no `//`, backslashes,
  control characters or whitespace).
- Secrets never reach the browser after they were entered: TOTP secrets after
  enrolment, API tokens after creation, the OIDC client secret, registry and
  TLS credentials.
- A fresh instance can only be claimed with the setup token from the server
  log / data directory; it is deleted once the admin exists.
- Agents (`/api/agent/*`) skip `proxy.ts` too: they have no session, and
  their upstream bodies must not be buffered. The handlers authenticate
  every request themselves: the connection by the environment's enrollment
  key (SHA-256 hash, constant-time compare; refused when the environment was
  deleted or the key rotated), upstream batches by a per-session secret,
  their order and size. Failed enrollments are limited per environment
  (20 per 5 minutes) and, with `TRUST_PROXY=true`, per client address (10),
  and audited once per window. Frames are capped (64 KB of data, 4 KB
  otherwise; batches 4 MB), tunneled connections per agent are limited, and
  the protocol carries no address: the agent only ever connects to its own
  Docker socket. Serve Gantry over HTTPS for agents across networks.
- Access to the Docker socket is equivalent to root on the host, and a
  cluster-admin token to the whole cluster. Keep Gantry on a trusted network
  or behind HTTPS.
