# Configuration

Gantry works without any configuration. Start it, open
http://localhost:3000 and create the first administrator:

```bash
docker compose up -d --build
```

Out of the box Gantry uses SQLite, manages the Docker of the host it runs
on, and keeps its data in the `gantry-data` volume. Change a setting only
when you need to.

- [Changing a setting](#changing-a-setting)
- [Common tasks](#common-tasks)
- [All settings](#all-settings)
- [Good to know](#good-to-know)
- [Upgrading from an older version](#upgrading-from-an-older-version)

## Changing a setting

1. Create a file named `.env` next to `docker-compose.yml`. The easiest way is
   to copy the example: `cp .env.example .env`.
2. Add or uncomment a line in the form `NAME=value`, for example:

   ```bash
   GANTRY_PORT=8080
   ```

3. Apply it:

   ```bash
   docker compose up -d
   ```

Every setting on this page can go in `.env`. Without Docker Compose, pass
settings to `docker run` with `-e NAME=value` (or `--env-file .env`). During
development, `pnpm dev` reads `.env` too.

Docker Compose 2.24 or newer is needed (`docker compose version`).

## Common tasks

### Use another port

```bash
GANTRY_PORT=8080
```

To accept connections only from the server itself (e.g. behind a reverse
proxy), use `GANTRY_PORT=127.0.0.1:3000`.

### Put Gantry on a domain with HTTPS

1. In Gantry, go to **Proxy** and choose *Built-in (Caddy)*. Then open
   Gantry's container and use **Expose via proxy** with your domain, port
   3000 and *Let's Encrypt*.
2. Add to `.env`:

   ```bash
   GANTRY_URL=https://gantry.example.com
   TRUST_PROXY=true
   GANTRY_PORT=127.0.0.1:3000
   ```

`TRUST_PROXY=true` is safe only when a proxy you control is in front of
Gantry.

### Create the administrator automatically

Useful for automated installs. Without these lines, the first visit asks you
to create the administrator.

```bash
GANTRY_ADMIN_USERNAME=admin
GANTRY_ADMIN_PASSWORD=a-long-password
```

### Use MySQL instead of SQLite

Add to `.env` **before the first start** (MySQL keeps the passwords it was
created with):

```bash
COMPOSE_FILE=docker-compose.yml:docker-compose.mysql.yml
MYSQL_PASSWORD=change-me
MYSQL_ROOT_PASSWORD=change-me-too
```

`docker compose up -d` then also starts a MySQL container (`gantry-mysql`)
and connects Gantry to it.

To use a MySQL server you already have, leave `COMPOSE_FILE` out and set
`DB_DRIVER=mysql` plus either `DATABASE_URL` or the `MYSQL_*` settings (see
[Database](#database)). The README's MySQL section lists the version and
privileges it needs.

### Keep backups on another disk

Mount the disk into the container and point `BACKUP_DIR` at it. Add a
`docker-compose.override.yml`:

```yaml
services:
  gantry:
    volumes:
      - /mnt/backup-disk/gantry:/backups
```

and to `.env`:

```bash
BACKUP_DIR=/backups
```

If `.env` already has a `COMPOSE_FILE` line (MySQL), add the override file to
it: `COMPOSE_FILE=docker-compose.yml:docker-compose.mysql.yml:docker-compose.override.yml`.

### Sign in with SSO (OpenID Connect)

Register `https://<your domain>/auth/oidc/callback` at your identity
provider, then:

```bash
GANTRY_URL=https://gantry.example.com
OIDC_ISSUER=https://id.example.com/realms/main
OIDC_CLIENT_ID=gantry
OIDC_CLIENT_SECRET=...
```

The other `OIDC_*` settings are optional (see
[Single sign-on](#single-sign-on-openid-connect)).

### Rootless Docker or another socket

```bash
DOCKER_SOCKET=/run/user/1000/docker.sock
```

## All settings

Every setting is optional. An empty value (`NAME=`) means the default.

### Basics

| Setting | Default | What it does |
| --- | --- | --- |
| `GANTRY_PORT` | `3000` | Port on the host. `127.0.0.1:3000` = only reachable from the server itself |
| `GANTRY_URL` | | Public address of Gantry, e.g. `https://gantry.example.com`. Needed for SSO and for the remote agent's command |
| `DOCKER_SOCKET` | `/var/run/docker.sock` | Docker socket of the host that Gantry manages as `local` |
| `COMPOSE_FILE` | | Set to `docker-compose.yml:docker-compose.mysql.yml` to use MySQL |

### Login and security

| Setting | Default | What it does |
| --- | --- | --- |
| `GANTRY_ADMIN_USERNAME` / `GANTRY_ADMIN_PASSWORD` | | Create the first administrator at startup |
| `GANTRY_SETUP_TOKEN` | random | Token the first-run page asks for. By default a random one is printed in the log (`docker logs gantry`). At least 16 characters |
| `GANTRY_SECRET` | generated | Key that signs sessions and encrypts stored passwords. Generated into the data volume if not set. At least 32 characters. **Keep it safe** |
| `SESSION_TTL_HOURS` | `12` | How long you stay signed in |
| `COOKIE_SECURE` | `auto` | `auto` marks the login cookie secure on HTTPS. `true` or `false` to force it |
| `TRUST_PROXY` | `false` | `true` only behind your own reverse proxy: then login limits see the real client address |

### Database

| Setting | Default | What it does |
| --- | --- | --- |
| `DB_DRIVER` | `sqlite` | `sqlite` or `mysql`. Set automatically when you use `docker-compose.mysql.yml` |
| `DATABASE_URL` | | MySQL connection in one line: `mysql://user:password@host:3306/gantry` |
| `MYSQL_HOST` / `MYSQL_PORT` | `127.0.0.1` / `3306` | MySQL server (`mysql` with `docker-compose.mysql.yml`) |
| `MYSQL_DATABASE` / `MYSQL_USER` | `gantry` / `gantry` | Database name and user |
| `MYSQL_PASSWORD` | | Password of that user (`gantry` with `docker-compose.mysql.yml` if not set) |
| `MYSQL_ROOT_PASSWORD` | `gantry-root` | Root password of the MySQL container from `docker-compose.mysql.yml` |
| `SQLITE_PATH` | `$DATA_DIR/gantry.db` | SQLite file (fixed to `/data/gantry.db` in Docker Compose) |
| `DATA_DIR` | `./data` | Folder for SQLite and generated keys (fixed to `/data` in Docker Compose) |

### Backups, history and update checks

| Setting | Default | What it does |
| --- | --- | --- |
| `BACKUP_DIR` | `$DATA_DIR/backups` | Where scheduled backups are written |
| `METRICS_INTERVAL_SECONDS` | `60` | How often the dashboard chart takes a sample (at least 10) |
| `METRICS_RETENTION_DAYS` | `7` | How long chart history is kept |
| `UPDATE_CHECK_INTERVAL_HOURS` | `6` | How often registries are asked for newer images. `0` = only when you click *Check updates* |

### File browser

| Setting | Default | What it does |
| --- | --- | --- |
| `FILES_UPLOAD_MAX_MB` | `512` | Largest file you can upload |
| `FILES_EDIT_MAX_KB` | `1024` | Largest text file the editor opens |
| `FILES_LIST_MAX_ENTRIES` | `5000` | Most entries shown per folder |
| `FILES_SCAN_MAX_MB` / `FILES_SCAN_TIMEOUT_SECONDS` | `512` / `30` | Limits for listing folders of stopped or shell-less containers |
| `FILES_HELPER_IMAGE` | `alpine:3` | Small image used to open volumes (needs `sh`, `stat`, `rm`) |
| `FILES_HELPER_IDLE_SECONDS` | `120` | How long that helper container is kept for reuse |

### Vulnerability scans (Trivy)

| Setting | Default | What it does |
| --- | --- | --- |
| `TRIVY_IMAGE` | `aquasec/trivy:0.76.1` | Scanner image |
| `TRIVY_CACHE_VOLUME` | `gantry-trivy-cache` | Volume that keeps the vulnerability database between scans |
| `TRIVY_TIMEOUT_MINUTES` | `20` | Longest one scan may take |
| `TRIVY_DB_REPOSITORY`, `TRIVY_JAVA_DB_REPOSITORY`, `TRIVY_SKIP_DB_UPDATE`, `TRIVY_SKIP_JAVA_DB_UPDATE`, `TRIVY_OFFLINE_SCAN`, `TRIVY_INSECURE` | | Passed to Trivy unchanged: database mirrors and offline use |

### Image builds

| Setting | Default | What it does |
| --- | --- | --- |
| `GANTRY_BUILD_MAX_CONTEXT_MB` | `512` | Largest build context (upload or Git) |
| `GANTRY_BUILD_TIMEOUT_MINUTES` | `60` | A build is stopped after this long |
| `GANTRY_BUILD_CONCURRENCY` | `2` | Builds running at the same time |

### Kubernetes (Helm)

| Setting | Default | What it does |
| --- | --- | --- |
| `HELM_BIN` | `helm` | The helm 3 program (already included in the Docker image) |
| `HELM_MAX_OPERATIONS` | `4` | Helm installs, upgrades and uninstalls running at the same time (1–64) |

### Remote hosts (agent)

| Setting | Default | What it does |
| --- | --- | --- |
| `GANTRY_AGENT_IMAGE` | `gantry:latest` | Image shown in the agent's `docker run` command |
| `GANTRY_AGENT_MAX_STREAMS` | `64` | Docker connections per agent at the same time (4–1024) |
| `GANTRY_AGENT_QUEUE_SECONDS` | `30` | How long a connection waits when all are busy |
| `GANTRY_AGENT_HEARTBEAT_SECONDS` | `10` | How often agents are pinged. Silent agents are dropped after 3.5 pings |

### Single sign-on (OpenID Connect)

SSO is on when both `OIDC_ISSUER` and `OIDC_CLIENT_ID` are set.

| Setting | Default | What it does |
| --- | --- | --- |
| `OIDC_ISSUER` | | Address of your identity provider |
| `OIDC_CLIENT_ID` / `OIDC_CLIENT_SECRET` | | Client registered there (the secret is optional for public clients) |
| `OIDC_REDIRECT_URL` | `$GANTRY_URL/auth/oidc/callback` | Callback address, if different |
| `OIDC_SCOPES` | `openid profile email` | Requested scopes |
| `OIDC_AUTO_CREATE` | `false` | `true` = create a standard user on someone's first SSO login |
| `OIDC_ADMIN_GROUPS` | | Groups (comma-separated) whose members become administrators |
| `OIDC_GROUPS_CLAIM` | `groups` | Claim that holds the groups |
| `OIDC_USERNAME_CLAIM` | `preferred_username` | Claim used as the username of new users |
| `PASSWORD_LOGIN` | `all` | `admins` = with SSO on, only administrators may still sign in with a password |

### Tests only

| Setting | Default | What it does |
| --- | --- | --- |
| `GANTRY_TEST_ALLOW_HTTP_GIT` | | Accept `http://` Git addresses on localhost. **Never in production** |

## Good to know

- **Docker access.** You don't need to look up the Docker group id. The
  container finds the group that owns the Docker socket, joins it, and then
  runs Gantry as the unprivileged `node` user. If you start the container with
  `--user`, give that user access yourself (`--group-add`).
- **Fixed values.** Inside the container, Docker Compose always uses port
  3000, `/data` for data and `/var/run/docker.sock` for the socket. Setting
  `PORT`, `DATA_DIR` or `SQLITE_PATH` in `.env` has no effect there. Use
  `GANTRY_PORT` and `DOCKER_SOCKET` instead.
- **Secrets.** `GANTRY_SECRET` (or the generated `secret.key` in the data
  volume) decrypts every stored credential. Back it up and keep it private.

## Upgrading from an older version

Older versions listed every setting in `docker-compose.yml`. If your `.env`
comes from then:

1. Remove `DOCKER_GID`: it is no longer needed.
2. Using MySQL? Replace `COMPOSE_PROFILES=mysql` and `DB_DRIVER=mysql` with:

   ```bash
   COMPOSE_FILE=docker-compose.yml:docker-compose.mysql.yml
   ```

   The container and volume names are the same, so your data stays.
3. Check the rest of `.env`. Some settings were ignored before (`FILES_*`,
   `TRIVY_*`, `HELM_*`, `GANTRY_BUILD_*`, `GANTRY_AGENT_*`, `DATABASE_URL`)
   and now take effect.
4. Rebuild and restart: `docker compose up -d --build`.
