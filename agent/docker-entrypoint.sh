#!/bin/sh
# Entrypoint of the Gantry image: the same image runs Gantry (the default
# command, `node server.js`) or the remote host agent (`agent`).
#
#   docker run … gantry:latest           -> Gantry
#   docker run … gantry:latest agent     -> agent (see agent/gantry-agent.mjs)
#   gantry-entrypoint healthcheck        -> used by the image's HEALTHCHECK
#
# Gantry itself runs as the unprivileged `node` user. The container starts as
# root only to give `node` the group that owns the mounted Docker socket, whose
# id differs from host to host, then drops to `node` for good. Started with
# --user (or --group-add and --user node), nothing is changed.
set -eu

# Adds `node` to the group owning the Docker socket, creating a group with
# that id when the image has none. Prints nothing; never fails the start.
join_socket_group() {
  sock="${DOCKER_SOCKET:-/var/run/docker.sock}"
  sock="${sock#unix://}"
  [ -S "$sock" ] || return 0
  gid=$(stat -c %g "$sock")
  group=$(awk -F: -v gid="$gid" '$3 == gid { print $1; exit }' /etc/group)
  if [ -z "$group" ]; then
    group=docker-host
    addgroup -g "$gid" "$group" 2>/dev/null || return 0
  fi
  case " $(id -Gn node) " in
    *" $group "*) ;;
    *) addgroup node "$group" 2>/dev/null || true ;;
  esac
}

case "${1:-}" in
  agent)
    shift
    exec node /app/agent/gantry-agent.mjs "$@"
    ;;
  healthcheck)
    if pgrep -f gantry-agent.mjs >/dev/null 2>&1; then
      # The agent refreshes this file while it is connected to Gantry.
      [ -n "$(find "${GANTRY_AGENT_HEALTH_FILE:-/tmp/gantry-agent.health}" -mmin -1 2>/dev/null)" ]
    else
      wget -qO- "http://127.0.0.1:${PORT:-3000}/api/health" >/dev/null
    fi
    ;;
  *)
    if [ "$(id -u)" = 0 ] && [ "${1:-}" = node ]; then
      join_socket_group
      export HOME=/home/node
      exec su-exec node "$@"
    fi
    exec "$@"
    ;;
esac
