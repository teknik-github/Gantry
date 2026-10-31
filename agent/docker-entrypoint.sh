#!/bin/sh
# Entrypoint of the Gantry image: the same image runs Gantry (the default
# command, `node server.js`) or the remote host agent (`agent`).
#
#   docker run … gantry:latest           -> Gantry
#   docker run … gantry:latest agent     -> agent (see agent/gantry-agent.mjs)
#   gantry-entrypoint healthcheck        -> used by the image's HEALTHCHECK
set -eu

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
    exec "$@"
    ;;
esac
