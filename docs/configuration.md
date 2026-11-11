# Configuration

Gantry needs no configuration: `docker compose up -d --build` (or `pnpm dev`)
starts it with SQLite, the local Docker socket and the defaults below. Change
only what you need.

## Where settings go

- **Docker Compose**: put `NAME=value` lines in `.env` next to
  `docker-compose.yml` (`.env.example` lists the common ones). Every variable
  in `.env` reaches the Gantry container as it is, so any variable on this page
  works there; restart with `docker compose up -d`. Needs Docker Compose 2.24
  or newer (`.env` is optional).
- **`docker run`**: pass them with `-e NAME=value` or `--env-file .env`.
- **Development** (`pnpm dev`): Next.js reads `.env` too.

An empty value (`NAME=`) counts as unset, so the default applies.

A few values are fixed inside the container by `docker-compose.yml`, whatever
`.env` says: `PORT` (3000), `DATA_DIR` (`/data`, the `gantry-data` volume),
`SQLITE_PATH` (`/data/gantry.db`) and `DOCKER_SOCKET` (the mounted
`/var/run/docker.sock`).

## Docker Compose only

These are read by `docker compose`, not by Gantry:

| Variable | Default | Description |
| --- | --- | --- |
| `GANTRY_PORT` | `3000` | Port (or `127.0.0.1:3000`) published on the host |
| `DOCKER_SOCKET` | `/var/run/docker.sock` | Docker socket **on the host** mounted into Gantry (e.g. `/run/user/1000/docker.sock` for rootless Docker) |
| `COMPOSE_FILE` | `docker-compose.yml` | `docker-compose.yml:docker-compose.mysql.yml` adds a MySQL container and points Gantry at it |
| `MYSQL_ROOT_PASSWORD` | `gantry-root` | Root password of that MySQL container |

## Docker socket access

Gantry runs as the unprivileged `node` user. The container starts as root
only long enough to add `node` to the group that owns the mounted socket
(whatever its id is on this host) and then drops to `node`, so there is no
group id to look up. Started with `--user`, the image changes nothing; give
that user the socket's group yourself (`--group-add`).

## MySQL

With Docker Compose, add to `.env`:

```bash
COMPOSE_FILE=docker-compose.yml:docker-compose.mysql.yml
MYSQL_PASSWORD=change-me
MYSQL_ROOT_PASSWORD=change-me-too
```

`docker compose up -d` then starts `gantry-mysql` and sets `DB_DRIVER=mysql`
and the connection for Gantry; `MYSQL_DATABASE` and `MYSQL_USER` default to
`gantry`. Set the passwords before the first start: MySQL keeps the ones it
was created with.

For an existing MySQL server (or `pnpm dev`), set `DB_DRIVER=mysql` and
either `DATABASE_URL=mysql://user:password@host:3306/gantry` or the
`MYSQL_HOST`, `MYSQL_PORT`, `MYSQL_DATABASE`, `MYSQL_USER` and
`MYSQL_PASSWORD` fields. Requirements are in the README (MySQL).

## All variables

| Variable | Default | Description |
| --- | --- | --- |
| `DB_DRIVER` | `sqlite` | `sqlite` or `mysql` |
| `SQLITE_PATH` | `$DATA_DIR/gantry.db` | SQLite file |
| `DATABASE_URL` | | MySQL connection as a URL (instead of the `MYSQL_*` fields) |
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
| `MYSQL_HOST` / `MYSQL_PORT` | `127.0.0.1` / `3306` | MySQL server (`mysql` / `3306` with `docker-compose.mysql.yml`) |
| `MYSQL_DATABASE` / `MYSQL_USER` / `MYSQL_PASSWORD` | `gantry` / `gantry` / empty | MySQL database and account (the compose MySQL container defaults the password to `gantry`) |
| `GANTRY_TEST_ALLOW_HTTP_GIT` | | Tests only: accept `http://` Git URLs on loopback hosts. Never set it in production |

## Upgrading from the older compose file

Earlier versions listed every variable in `docker-compose.yml` and needed
`DOCKER_GID`, `DB_DRIVER=mysql` and `COMPOSE_PROFILES=mysql`. With the new
files:

- `DOCKER_GID` is no longer used; remove it.
- MySQL: replace `COMPOSE_PROFILES=mysql` (and `DB_DRIVER=mysql`) with
  `COMPOSE_FILE=docker-compose.yml:docker-compose.mysql.yml`. The service,
  container and volume names are unchanged, so the database is kept.
- Variables that the old file did not pass on (`FILES_*`, `TRIVY_*`, `HELM_*`,
  `GANTRY_BUILD_*`, `GANTRY_AGENT_*`, `DATABASE_URL`, …) now take effect.
  Check `.env` for values you set and expected to be ignored.
- Rebuild the image (`docker compose up -d --build`): the entrypoint that
  joins the socket's group is part of it.
