# Gantry

A Portainer-style web UI for Docker, built with Next.js 16 and shadcn/ui
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
- **Bulk actions**: tick several containers, images, volumes or networks and
  start/stop/restart/pause/resume/kill or remove them at once
- Multiple Docker environments: local socket or TCP, optionally with mutual TLS;
  standard users only see the environments they were given
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
- Private registries: mount a docker `config.json` and set `DOCKER_CONFIG`.
- Stack names are compose project names (`^[a-z0-9][a-z0-9_-]{0,62}$`). A name
  that matches an existing compose project is refused; use **Import** instead.
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
- Access to the Docker socket is equivalent to root on the host. Keep Gantry
  on a trusted network or behind HTTPS.
