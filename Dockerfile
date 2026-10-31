# syntax=docker/dockerfile:1

FROM node:24-alpine AS base
RUN corepack enable
WORKDIR /app

FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile

FROM base AS build
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN pnpm build

# helm for installing/upgrading charts on Kubernetes environments: a pinned
# release, verified against its published SHA-256 for the target architecture
# (downloaded on the build platform, so multi-arch builds need no emulation).
FROM --platform=$BUILDPLATFORM node:24-alpine AS helm
ARG TARGETARCH
ARG HELM_VERSION=v3.19.0
ARG HELM_SHA256_AMD64=a7f81ce08007091b86d8bd696eb4d86b8d0f2e1b9f6c714be62f82f96a594496
ARG HELM_SHA256_ARM64=440cf7add0aee27ebc93fada965523c1dc2e0ab340d4348da2215737fc0d76ad
RUN set -eu; \
    arch="${TARGETARCH:-$(uname -m | sed 's/x86_64/amd64/; s/aarch64/arm64/')}"; \
    case "$arch" in \
      amd64) sum="$HELM_SHA256_AMD64" ;; \
      arm64) sum="$HELM_SHA256_ARM64" ;; \
      *) echo "helm: no pinned checksum for architecture $arch" >&2; exit 1 ;; \
    esac; \
    wget -qO /tmp/helm.tgz "https://get.helm.sh/helm-${HELM_VERSION}-linux-${arch}.tar.gz"; \
    echo "$sum  /tmp/helm.tgz" | sha256sum -c -; \
    tar -xzf /tmp/helm.tgz -C /tmp; \
    install -m 0755 "/tmp/linux-${arch}/helm" /usr/local/bin/helm; \
    if [ "$arch" = "$(uname -m | sed 's/x86_64/amd64/; s/aarch64/arm64/')" ]; then /usr/local/bin/helm version --short; fi

FROM node:24-alpine AS runner
# docker compose CLI for stacks (talks to the environment's daemon via DOCKER_HOST),
# git for stacks sourced from a Git repository.
RUN apk add --no-cache docker-cli docker-cli-compose git
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    HOSTNAME=0.0.0.0 \
    PORT=3000 \
    DATA_DIR=/data

COPY --from=build --chown=node:node /app/.next/standalone ./
COPY --from=build --chown=node:node /app/.next/static ./.next/static
COPY --from=build --chown=node:node /app/public ./public
COPY --from=helm /usr/local/bin/helm /usr/local/bin/helm
# The remote host agent (`docker run … gantry agent`): one dependency-free script.
COPY --chown=node:node agent/gantry-agent.mjs ./agent/gantry-agent.mjs
COPY --chmod=0755 agent/docker-entrypoint.sh /usr/local/bin/gantry-entrypoint
RUN mkdir -p /data && chown node:node /data

# Runs unprivileged; docker-compose adds the docker socket's group.
USER node
VOLUME ["/data"]
EXPOSE 3000

# Gantry: its /api/health. The agent: connected to Gantry within the last minute.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD gantry-entrypoint healthcheck || exit 1

# `agent` as the command runs the agent instead of Gantry (agent/docker-entrypoint.sh).
ENTRYPOINT ["gantry-entrypoint"]
CMD ["node", "server.js"]
