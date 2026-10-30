import type { Template, TemplateVariable } from "@/lib/templates"

// Built-in stack templates. Each is a plain compose file using ${VARIABLES}
// that the deploy form asks for; named volumes keep data across redeploys.
// tests/integration/template-catalog.test.ts runs `docker compose config` on
// every one of them.

type BuiltinTemplate = Omit<Template, "source" | "key"> & { slug: string }

const port = (name: string, label: string, def: string): TemplateVariable => ({
  name,
  label,
  default: def,
  type: "port",
  required: true,
})

const password = (name: string, label: string, description?: string): TemplateVariable => ({
  name,
  label,
  description: description ?? "Leave empty to generate one",
  type: "password",
  required: true,
})

const text = (name: string, label: string, def: string, description?: string): TemplateVariable => ({
  name,
  label,
  default: def,
  description,
  type: "text",
  required: true,
})

const BUILTIN: BuiltinTemplate[] = [
  {
    slug: "nginx",
    title: "Nginx",
    description: "Web server and reverse proxy serving a static site from a volume.",
    category: "Web",
    stackName: "nginx",
    website: "https://nginx.org",
    variables: [port("HTTP_PORT", "HTTP port", "8080")],
    compose: `services:
  nginx:
    image: nginx:stable-alpine
    restart: unless-stopped
    ports:
      - "\${HTTP_PORT}:80"
    volumes:
      - html:/usr/share/nginx/html

volumes:
  html:
`,
  },
  {
    slug: "wordpress",
    title: "WordPress",
    description: "WordPress with a MariaDB database.",
    category: "Web",
    stackName: "wordpress",
    website: "https://wordpress.org",
    variables: [
      port("HTTP_PORT", "HTTP port", "8081"),
      text("DB_NAME", "Database name", "wordpress"),
      text("DB_USER", "Database user", "wordpress"),
      password("DB_PASSWORD", "Database password"),
      password("DB_ROOT_PASSWORD", "Database root password"),
    ],
    compose: `services:
  wordpress:
    image: wordpress:6-apache
    restart: unless-stopped
    depends_on:
      - db
    ports:
      - "\${HTTP_PORT}:80"
    environment:
      WORDPRESS_DB_HOST: db
      WORDPRESS_DB_NAME: \${DB_NAME}
      WORDPRESS_DB_USER: \${DB_USER}
      WORDPRESS_DB_PASSWORD: \${DB_PASSWORD}
    volumes:
      - wordpress:/var/www/html

  db:
    image: mariadb:11
    restart: unless-stopped
    environment:
      MARIADB_DATABASE: \${DB_NAME}
      MARIADB_USER: \${DB_USER}
      MARIADB_PASSWORD: \${DB_PASSWORD}
      MARIADB_ROOT_PASSWORD: \${DB_ROOT_PASSWORD}
    volumes:
      - db:/var/lib/mysql

volumes:
  wordpress:
  db:
`,
  },
  {
    slug: "postgres",
    title: "PostgreSQL",
    description: "PostgreSQL database server.",
    category: "Database",
    stackName: "postgres",
    website: "https://www.postgresql.org",
    variables: [
      port("DB_PORT", "Host port", "5432"),
      text("POSTGRES_USER", "User", "app"),
      password("POSTGRES_PASSWORD", "Password"),
      text("POSTGRES_DB", "Database", "app"),
    ],
    compose: `services:
  postgres:
    image: postgres:17-alpine
    restart: unless-stopped
    ports:
      - "\${DB_PORT}:5432"
    environment:
      POSTGRES_USER: \${POSTGRES_USER}
      POSTGRES_PASSWORD: \${POSTGRES_PASSWORD}
      POSTGRES_DB: \${POSTGRES_DB}
    volumes:
      - data:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U \${POSTGRES_USER} -d \${POSTGRES_DB}"]
      interval: 10s
      timeout: 5s
      retries: 5

volumes:
  data:
`,
  },
  {
    slug: "mysql",
    title: "MySQL",
    description: "MySQL 8.4 LTS database server.",
    category: "Database",
    stackName: "mysql",
    website: "https://www.mysql.com",
    variables: [
      port("DB_PORT", "Host port", "3306"),
      password("MYSQL_ROOT_PASSWORD", "Root password"),
      text("MYSQL_DATABASE", "Database", "app"),
      text("MYSQL_USER", "User", "app"),
      password("MYSQL_PASSWORD", "User password"),
    ],
    compose: `services:
  mysql:
    image: mysql:8.4
    restart: unless-stopped
    ports:
      - "\${DB_PORT}:3306"
    environment:
      MYSQL_ROOT_PASSWORD: \${MYSQL_ROOT_PASSWORD}
      MYSQL_DATABASE: \${MYSQL_DATABASE}
      MYSQL_USER: \${MYSQL_USER}
      MYSQL_PASSWORD: \${MYSQL_PASSWORD}
    volumes:
      - data:/var/lib/mysql

volumes:
  data:
`,
  },
  {
    slug: "mariadb",
    title: "MariaDB",
    description: "MariaDB 11 database server.",
    category: "Database",
    stackName: "mariadb",
    website: "https://mariadb.org",
    variables: [
      port("DB_PORT", "Host port", "3307"),
      password("MARIADB_ROOT_PASSWORD", "Root password"),
      text("MARIADB_DATABASE", "Database", "app"),
      text("MARIADB_USER", "User", "app"),
      password("MARIADB_PASSWORD", "User password"),
    ],
    compose: `services:
  mariadb:
    image: mariadb:11
    restart: unless-stopped
    ports:
      - "\${DB_PORT}:3306"
    environment:
      MARIADB_ROOT_PASSWORD: \${MARIADB_ROOT_PASSWORD}
      MARIADB_DATABASE: \${MARIADB_DATABASE}
      MARIADB_USER: \${MARIADB_USER}
      MARIADB_PASSWORD: \${MARIADB_PASSWORD}
    volumes:
      - data:/var/lib/mysql

volumes:
  data:
`,
  },
  {
    slug: "mongodb",
    title: "MongoDB",
    description: "MongoDB document database with a root user.",
    category: "Database",
    stackName: "mongodb",
    website: "https://www.mongodb.com",
    variables: [
      port("DB_PORT", "Host port", "27017"),
      text("MONGO_USER", "Root user", "root"),
      password("MONGO_PASSWORD", "Root password"),
    ],
    compose: `services:
  mongo:
    image: mongo:8
    restart: unless-stopped
    ports:
      - "\${DB_PORT}:27017"
    environment:
      MONGO_INITDB_ROOT_USERNAME: \${MONGO_USER}
      MONGO_INITDB_ROOT_PASSWORD: \${MONGO_PASSWORD}
    volumes:
      - data:/data/db

volumes:
  data:
`,
  },
  {
    slug: "redis",
    title: "Redis",
    description: "Redis with a password and append-only persistence.",
    category: "Database",
    stackName: "redis",
    website: "https://redis.io",
    variables: [port("REDIS_PORT", "Host port", "6379"), password("REDIS_PASSWORD", "Password")],
    compose: `services:
  redis:
    image: redis:7-alpine
    restart: unless-stopped
    command: ["redis-server", "--requirepass", "\${REDIS_PASSWORD}", "--appendonly", "yes"]
    ports:
      - "\${REDIS_PORT}:6379"
    volumes:
      - data:/data

volumes:
  data:
`,
  },
  {
    slug: "adminer",
    title: "Adminer",
    description: "Database admin in one page (MySQL, PostgreSQL, SQLite and more).",
    category: "Database tools",
    stackName: "adminer",
    website: "https://www.adminer.org",
    variables: [port("HTTP_PORT", "HTTP port", "8082")],
    compose: `services:
  adminer:
    image: adminer:latest
    restart: unless-stopped
    ports:
      - "\${HTTP_PORT}:8080"
`,
  },
  {
    slug: "phpmyadmin",
    title: "phpMyAdmin",
    description: "Web UI for MySQL and MariaDB; connect to any server by host name.",
    category: "Database tools",
    stackName: "phpmyadmin",
    website: "https://www.phpmyadmin.net",
    variables: [port("HTTP_PORT", "HTTP port", "8083")],
    compose: `services:
  phpmyadmin:
    image: phpmyadmin:latest
    restart: unless-stopped
    ports:
      - "\${HTTP_PORT}:80"
    environment:
      PMA_ARBITRARY: "1"
`,
  },
  {
    slug: "uptime-kuma",
    title: "Uptime Kuma",
    description: "Self-hosted uptime monitoring with status pages and notifications.",
    category: "Monitoring",
    stackName: "uptime-kuma",
    website: "https://github.com/louislam/uptime-kuma",
    variables: [port("HTTP_PORT", "HTTP port", "3001")],
    compose: `services:
  uptime-kuma:
    image: louislam/uptime-kuma:1
    restart: unless-stopped
    ports:
      - "\${HTTP_PORT}:3001"
    volumes:
      - data:/app/data

volumes:
  data:
`,
  },
  {
    slug: "grafana-prometheus",
    title: "Grafana + Prometheus",
    description: "Metrics stack: Prometheus (scraping itself) with Grafana on top.",
    category: "Monitoring",
    stackName: "monitoring",
    website: "https://grafana.com",
    variables: [
      port("GRAFANA_PORT", "Grafana port", "3000"),
      port("PROMETHEUS_PORT", "Prometheus port", "9090"),
      password("GRAFANA_ADMIN_PASSWORD", "Grafana admin password", "User: admin. Leave empty to generate one"),
    ],
    compose: `services:
  prometheus:
    image: prom/prometheus:latest
    restart: unless-stopped
    ports:
      - "\${PROMETHEUS_PORT}:9090"
    volumes:
      - prometheus:/prometheus

  grafana:
    image: grafana/grafana-oss:latest
    restart: unless-stopped
    depends_on:
      - prometheus
    ports:
      - "\${GRAFANA_PORT}:3000"
    environment:
      GF_SECURITY_ADMIN_USER: admin
      GF_SECURITY_ADMIN_PASSWORD: \${GRAFANA_ADMIN_PASSWORD}
    volumes:
      - grafana:/var/lib/grafana

volumes:
  prometheus:
  grafana:
`,
  },
  {
    slug: "gitea",
    title: "Gitea",
    description: "Lightweight self-hosted Git service (SQLite), with SSH.",
    category: "Development",
    stackName: "gitea",
    website: "https://about.gitea.com",
    variables: [port("HTTP_PORT", "HTTP port", "3002"), port("SSH_PORT", "SSH port", "2222")],
    compose: `services:
  gitea:
    image: gitea/gitea:1
    restart: unless-stopped
    environment:
      USER_UID: "1000"
      USER_GID: "1000"
      GITEA__server__SSH_PORT: \${SSH_PORT}
    ports:
      - "\${HTTP_PORT}:3000"
      - "\${SSH_PORT}:22"
    volumes:
      - data:/data

volumes:
  data:
`,
  },
  {
    slug: "code-server",
    title: "code-server",
    description: "VS Code in the browser.",
    category: "Development",
    stackName: "code-server",
    website: "https://github.com/coder/code-server",
    variables: [port("HTTP_PORT", "HTTP port", "8443"), password("PASSWORD", "Login password")],
    compose: `services:
  code-server:
    image: lscr.io/linuxserver/code-server:latest
    restart: unless-stopped
    environment:
      PUID: "1000"
      PGID: "1000"
      TZ: Etc/UTC
      PASSWORD: \${PASSWORD}
    ports:
      - "\${HTTP_PORT}:8443"
    volumes:
      - config:/config

volumes:
  config:
`,
  },
  {
    slug: "mailpit",
    title: "Mailpit",
    description: "Catches outgoing email from your apps (SMTP) and shows it in a web UI.",
    category: "Development",
    stackName: "mailpit",
    website: "https://mailpit.axllent.org",
    variables: [port("HTTP_PORT", "Web UI port", "8025"), port("SMTP_PORT", "SMTP port", "1025")],
    compose: `services:
  mailpit:
    image: axllent/mailpit:latest
    restart: unless-stopped
    ports:
      - "\${HTTP_PORT}:8025"
      - "\${SMTP_PORT}:1025"
    volumes:
      - data:/data
    environment:
      MP_DATABASE: /data/mailpit.db

volumes:
  data:
`,
  },
  {
    slug: "n8n",
    title: "n8n",
    description: "Workflow automation with a visual editor.",
    category: "Automation",
    stackName: "n8n",
    website: "https://n8n.io",
    variables: [
      port("HTTP_PORT", "HTTP port", "5678"),
      // Not "TZ": compose prefers its own process environment over .env for that one.
      text("TIMEZONE", "Time zone", "Asia/Jakarta"),
    ],
    compose: `services:
  n8n:
    image: docker.n8n.io/n8nio/n8n:latest
    restart: unless-stopped
    ports:
      - "\${HTTP_PORT}:5678"
    environment:
      GENERIC_TIMEZONE: \${TIMEZONE}
      TZ: \${TIMEZONE}
      # Plain HTTP; remove when served over HTTPS.
      N8N_SECURE_COOKIE: "false"
    volumes:
      - data:/home/node/.n8n

volumes:
  data:
`,
  },
  {
    slug: "node-red",
    title: "Node-RED",
    description: "Flow-based programming for IoT and automation.",
    category: "Automation",
    stackName: "node-red",
    website: "https://nodered.org",
    variables: [port("HTTP_PORT", "HTTP port", "1880")],
    compose: `services:
  node-red:
    image: nodered/node-red:latest
    restart: unless-stopped
    ports:
      - "\${HTTP_PORT}:1880"
    volumes:
      - data:/data

volumes:
  data:
`,
  },
  {
    slug: "minio",
    title: "MinIO",
    description: "S3-compatible object storage with a web console.",
    category: "Storage",
    stackName: "minio",
    website: "https://min.io",
    variables: [
      port("API_PORT", "S3 API port", "9000"),
      port("CONSOLE_PORT", "Console port", "9001"),
      text("MINIO_ROOT_USER", "Root user", "minioadmin"),
      password("MINIO_ROOT_PASSWORD", "Root password", "At least 8 characters. Leave empty to generate one"),
    ],
    compose: `services:
  minio:
    image: minio/minio:latest
    restart: unless-stopped
    command: ["server", "/data", "--console-address", ":9001"]
    ports:
      - "\${API_PORT}:9000"
      - "\${CONSOLE_PORT}:9001"
    environment:
      MINIO_ROOT_USER: \${MINIO_ROOT_USER}
      MINIO_ROOT_PASSWORD: \${MINIO_ROOT_PASSWORD}
    volumes:
      - data:/data

volumes:
  data:
`,
  },
  {
    slug: "rabbitmq",
    title: "RabbitMQ",
    description: "Message broker with the management UI.",
    category: "Messaging",
    stackName: "rabbitmq",
    website: "https://www.rabbitmq.com",
    variables: [
      port("AMQP_PORT", "AMQP port", "5672"),
      port("HTTP_PORT", "Management UI port", "15672"),
      text("RABBITMQ_USER", "User", "admin"),
      password("RABBITMQ_PASSWORD", "Password"),
    ],
    compose: `services:
  rabbitmq:
    image: rabbitmq:4-management-alpine
    restart: unless-stopped
    ports:
      - "\${AMQP_PORT}:5672"
      - "\${HTTP_PORT}:15672"
    environment:
      RABBITMQ_DEFAULT_USER: \${RABBITMQ_USER}
      RABBITMQ_DEFAULT_PASS: \${RABBITMQ_PASSWORD}
    volumes:
      - data:/var/lib/rabbitmq

volumes:
  data:
`,
  },
]

export const BUILTIN_TEMPLATES: Template[] = BUILTIN.map(({ slug, ...t }) => ({ ...t, key: slug, source: "builtin" }))

export function builtinTemplate(key: string) {
  return BUILTIN_TEMPLATES.find((t) => t.key === key) ?? null
}
