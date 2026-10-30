// Pure notification helpers: alert kinds, channel types with their settings,
// and the HTTP request each service expects. Sending happens in
// lib/server/notifications.ts; nothing here touches the network.

export const ALERT_KINDS = {
  container_crash: { label: "Container crashed", description: "Exited with a non-zero code without being stopped" },
  container_oom: { label: "Out of memory", description: "Killed by the kernel OOM killer" },
  container_unhealthy: { label: "Unhealthy", description: "Healthcheck reports unhealthy" },
  container_restart_loop: { label: "Restart loop", description: "Died 3 times within 10 minutes" },
  environment_down: { label: "Environment unreachable", description: "Docker host down for 2 minutes, and when it is back" },
  image_update: { label: "Image update available", description: "A newer image was found for a container's tag" },
  auto_update: { label: "Auto-update result", description: "What the scheduled update changed or failed to change" },
} as const

export type AlertKind = keyof typeof ALERT_KINDS

export const ALERT_KIND_KEYS = Object.keys(ALERT_KINDS) as AlertKind[]

export type Alert = {
  kind: AlertKind | "test"
  environment: string
  /** One line, e.g. "web-1 crashed (exit code 1)". */
  subject: string
  /** Details; may be several lines. */
  message: string
  /** ISO time. */
  time: string
}

type Field = {
  name: string
  label: string
  placeholder?: string
  description?: string
  /** Secret fields are encrypted, never shown again and kept when left empty on edit. */
  secret?: boolean
  optional?: boolean
  /** "url" fields must be http(s). */
  kind?: "url" | "text"
}

export const CHANNEL_TYPES = {
  telegram: {
    label: "Telegram",
    fields: [
      { name: "botToken", label: "Bot token", placeholder: "123456:ABC-DEF…", secret: true, description: "From @BotFather" },
      { name: "chatId", label: "Chat ID", placeholder: "-1001234567890", description: "User, group or channel id; the bot must be a member" },
    ],
  },
  discord: {
    label: "Discord",
    fields: [{ name: "webhookUrl", label: "Webhook URL", kind: "url", secret: true, placeholder: "https://discord.com/api/webhooks/…" }],
  },
  slack: {
    label: "Slack",
    fields: [{ name: "webhookUrl", label: "Webhook URL", kind: "url", secret: true, placeholder: "https://hooks.slack.com/services/…" }],
  },
  ntfy: {
    label: "ntfy",
    fields: [
      { name: "server", label: "Server", kind: "url", placeholder: "https://ntfy.sh" },
      { name: "topic", label: "Topic", placeholder: "gantry-alerts" },
      { name: "token", label: "Access token", secret: true, optional: true, description: "Only for protected topics" },
    ],
  },
  webhook: {
    label: "Webhook (JSON)",
    fields: [
      { name: "url", label: "URL", kind: "url", secret: true, placeholder: "https://example.com/hooks/gantry", description: "Receives a JSON POST per alert" },
    ],
  },
} as const satisfies Record<string, { label: string; fields: readonly Field[] }>

export type ChannelType = keyof typeof CHANNEL_TYPES

export const CHANNEL_TYPE_KEYS = Object.keys(CHANNEL_TYPES) as ChannelType[]

export function channelFields(type: ChannelType): readonly Field[] {
  return CHANNEL_TYPES[type].fields
}

export type ChannelConfig = Record<string, string>

/**
 * Validates submitted settings for a channel type. On edit, empty secret
 * fields keep the `previous` value.
 */
export function checkChannelConfig(
  type: ChannelType,
  submitted: Record<string, string | undefined>,
  previous?: ChannelConfig
): { config: ChannelConfig; errors: Record<string, string> } {
  const config: ChannelConfig = {}
  const errors: Record<string, string> = {}
  for (const f of channelFields(type) as readonly Field[]) {
    let value = (submitted[f.name] ?? "").trim()
    if (!value && f.secret && previous?.[f.name]) value = previous[f.name]
    if (!value) {
      if (!f.optional) errors[f.name] = "Required"
      continue
    }
    if (value.length > 2000) errors[f.name] = "Too long"
    else if (f.kind === "url" && !isHttpUrl(value)) errors[f.name] = "Use an http(s) URL"
    config[f.name] = value
  }
  if (type === "ntfy" && config.topic && !/^[A-Za-z0-9_-]{1,64}$/.test(config.topic)) {
    errors.topic = "Letters, digits, - and _ (max 64)"
  }
  if (type === "telegram" && config.chatId && !/^(-?\d{1,20}|@[A-Za-z0-9_]{5,32})$/.test(config.chatId)) {
    errors.chatId = "A numeric id or @channelname"
  }
  return { config, errors }
}

function isHttpUrl(value: string) {
  try {
    const u = new URL(value)
    return (u.protocol === "https:" || u.protocol === "http:") && Boolean(u.hostname)
  } catch {
    return false
  }
}

/** Plain-text rendering used by chat services. */
export function alertText(alert: Alert) {
  const head = `[Gantry · ${alert.environment}] ${alert.subject}`
  return alert.message ? `${head}\n${alert.message}` : head
}

export type HttpRequest = { url: string; method: "POST"; headers: Record<string, string>; body: string }

/** The request that delivers `alert` to a channel. */
export function buildRequest(type: ChannelType, config: ChannelConfig, alert: Alert): HttpRequest {
  const json = (url: string, body: unknown): HttpRequest => ({
    url,
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
  const text = alertText(alert)
  switch (type) {
    case "telegram":
      return json(`https://api.telegram.org/bot${encodeURIComponent(config.botToken)}/sendMessage`, {
        chat_id: config.chatId,
        text: text.slice(0, 4000),
        disable_web_page_preview: true,
      })
    case "discord":
      return json(config.webhookUrl, { content: text.slice(0, 1900), allowed_mentions: { parse: [] } })
    case "slack":
      return json(config.webhookUrl, { text: text.slice(0, 3000) })
    case "ntfy": {
      const headers: Record<string, string> = {
        "Content-Type": "text/plain; charset=utf-8",
        // Header values must be ASCII; keep the title simple.
        Title: `Gantry ${alert.environment}: ${alert.subject}`.replace(/[^\x20-\x7e]/g, "?").slice(0, 200),
        Tags: alert.kind === "auto_update" || alert.kind === "image_update" || alert.kind === "test" ? "package" : "warning",
      }
      if (alert.kind === "container_crash" || alert.kind === "container_oom" || alert.kind === "environment_down") headers.Priority = "high"
      if (config.token) headers.Authorization = `Bearer ${config.token}`
      return { url: `${config.server.replace(/\/+$/, "")}/${encodeURIComponent(config.topic)}`, method: "POST", headers, body: alert.message || alert.subject }
    }
    case "webhook":
      return json(config.url, { source: "gantry", ...alert })
  }
}

/** A short, secret-free description of a channel's target for the list. */
export function channelTarget(type: ChannelType, config: ChannelConfig) {
  switch (type) {
    case "telegram":
      return `chat ${config.chatId ?? "?"}`
    case "ntfy":
      return `${config.server?.replace(/^https?:\/\//, "") ?? "?"}/${config.topic ?? "?"}`
    default: {
      const url = config.webhookUrl ?? config.url
      try {
        return url ? new URL(url).host : "?"
      } catch {
        return "?"
      }
    }
  }
}
