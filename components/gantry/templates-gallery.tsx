"use client"

import * as React from "react"
import Link from "next/link"
import { SearchIcon } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { useI18n } from "@/lib/i18n/client"
import { cn } from "@/lib/utils"

export type TemplateCard = {
  key: string
  title: string
  description: string
  category: string
  source: "builtin" | "custom"
  services: string[]
}

const ALL = "all"
const CUSTOM = "custom"

// A stable colour per category for the initials tile.
const TILE_COLORS = [
  // The palette's container colours (app/globals.css).
  "bg-harbor/12 text-harbor",
  "bg-sea/12 text-sea",
  "bg-rust/12 text-rust",
  "bg-steel/12 text-steel",
  "bg-crane/20 text-dock dark:text-crane",
]

function tileColor(category: string) {
  let h = 0
  for (const ch of category) h = (h * 31 + ch.charCodeAt(0)) >>> 0
  return TILE_COLORS[h % TILE_COLORS.length]
}

function initials(title: string) {
  const words = title.replace(/[^A-Za-z0-9 +]/g, " ").split(/[\s+]+/).filter(Boolean)
  return (words.length > 1 ? words[0][0] + words[1][0] : title.slice(0, 2)).toUpperCase()
}

export function TemplatesGallery({ templates }: { templates: TemplateCard[] }) {
  const i18n = useI18n()
  const text = i18n.t.templates.gallery
  const [query, setQuery] = React.useState("")
  const [filter, setFilter] = React.useState(ALL)
  const categories = [...new Set(templates.filter((t) => t.source === "builtin").map((t) => t.category))]
  const hasCustom = templates.some((t) => t.source === "custom")

  const q = query.trim().toLowerCase()
  const shown = templates.filter((t) => {
    if (filter === CUSTOM ? t.source !== "custom" : filter !== ALL && t.category !== filter) return false
    return !q || `${t.title} ${t.description} ${t.category} ${t.services.join(" ")}`.toLowerCase().includes(q)
  })

  return (
    <div className="flex flex-col gap-4 px-4 lg:px-6">
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative w-full max-w-xs">
          <SearchIcon className="absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={text.searchPlaceholder}
            className="h-8 pl-8"
            aria-label={text.search}
          />
        </div>
        <ToggleGroup
          type="single"
          variant="outline"
          size="sm"
          value={filter}
          onValueChange={(v) => setFilter(v || ALL)}
          className="flex-wrap"
          aria-label={text.category}
        >
          <ToggleGroupItem value={ALL}>{text.all}</ToggleGroupItem>
          {hasCustom ? <ToggleGroupItem value={CUSTOM}>{text.custom}</ToggleGroupItem> : null}
          {categories.map((c) => (
            <ToggleGroupItem key={c} value={c}>
              {c}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </div>

      {shown.length ? (
        <div className="grid grid-cols-1 gap-4 @xl/main:grid-cols-2 @5xl/main:grid-cols-3 @7xl/main:grid-cols-4">
          {shown.map((t) => (
            <Link
              key={t.key}
              href={`/templates/${t.key}`}
              className="rounded-xl outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
              aria-label={i18n.format(text.templateLabel, { title: t.title })}
            >
              <Card className="h-full transition-colors hover:bg-muted/40">
                <CardHeader className="flex flex-row items-start gap-3">
                  <div
                    className={cn(
                      "flex size-10 shrink-0 items-center justify-center rounded-lg text-sm font-semibold",
                      tileColor(t.category)
                    )}
                    aria-hidden
                  >
                    {initials(t.title)}
                  </div>
                  <div className="flex min-w-0 flex-col gap-1.5">
                    <CardTitle className="flex flex-wrap items-center gap-2">
                      {t.title}
                      {t.source === "custom" ? <Badge variant="secondary">{text.customBadge}</Badge> : null}
                    </CardTitle>
                    <CardDescription className="line-clamp-2">{t.description || text.noDescription}</CardDescription>
                    <div className="flex flex-wrap gap-1 text-xs text-muted-foreground">
                      <span>{t.category}</span>
                      <span aria-hidden>·</span>
                      <span>{i18n.plural(text.services, t.services.length)}</span>
                    </div>
                  </div>
                </CardHeader>
              </Card>
            </Link>
          ))}
        </div>
      ) : (
        <p className="py-12 text-center text-sm text-muted-foreground">{text.noMatch}</p>
      )}
    </div>
  )
}
