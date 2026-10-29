# Gantry

A Portainer-style web UI for Docker, built with Next.js 16 and shadcn/ui
(`login-02` for authentication, `dashboard-01` for the app shell).

- Dashboard with container/image/volume/network totals and live CPU and memory usage
- Containers: list, start/stop/restart/pause/kill, remove, create, inspect, live logs,
  and an interactive console (`docker exec` shell in the browser, admins only)
- Images (pull, remove, prune), volumes and networks (create, remove)
- Multiple Docker environments (local socket or TCP), switchable from the sidebar
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

Open http://localhost:3000. On first visit you are asked to create the
administrator account.

## Development

```bash
pnpm install
pnpm dev -H 0.0.0.0 -p 3001   # SQLite at ./data/gantry.db
```

Extra hosts that load the dev server are listed in `allowedDevOrigins` in
`next.config.ts`.

## Tests

```bash
pnpm test        # unit tests (Vitest): passwords, session tokens, redirects, rate limit
pnpm test:e2e    # E2E (Playwright): login flows and the container console
```

`pnpm test:e2e` builds the app, starts the standalone server on port 3100 with
a fresh SQLite database, and runs the login suite first (it creates the admin
the other suites use). The console tests start a throwaway `alpine:3`
container and remove it afterwards; they are skipped when Docker isn't
reachable. Useful switches:

- `E2E_SKIP_BUILD=1` reuses the last `pnpm build`
- `E2E_BASE_URL=http://host:port` targets a running, not-yet-set-up Gantry instead

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
| `TRUST_PROXY` | `false` | Trust `X-Forwarded-For` from your reverse proxy (per-client login limits) |
| `DOCKER_SOCKET` | `/var/run/docker.sock` | Socket of the default `local` environment |

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
- Access to the Docker socket is equivalent to root on the host. Keep Gantry
  on a trusted network or behind HTTPS, and finish the first-run setup right
  after starting it.
