import { describe, expect, it } from "vitest"

import { formatBytes } from "@/lib/format"
import { i18nFor, interpolate, placeholdersOf } from "@/lib/i18n"
import { DEFAULT_LOCALE, LOCALES } from "@/lib/i18n/config"
import { dictionaries } from "@/lib/i18n/dictionaries"

type Tree = { readonly [key: string]: string | Tree }

/** Every message of a dictionary by its dotted key. */
function flatten(tree: Tree, prefix = ""): Map<string, string> {
  const out = new Map<string, string>()
  for (const [key, value] of Object.entries(tree)) {
    const path = prefix ? `${prefix}.${key}` : key
    if (typeof value === "string") out.set(path, value)
    else for (const [k, v] of flatten(value, path)) out.set(k, v)
  }
  return out
}

const source = flatten(dictionaries[DEFAULT_LOCALE] as Tree)

describe("dictionaries", () => {
  it("English has messages", () => {
    expect(source.size).toBeGreaterThan(100)
  })

  for (const locale of LOCALES.filter((l) => l !== DEFAULT_LOCALE)) {
    const messages = flatten(dictionaries[locale] as Tree)

    it(`${locale} has exactly the English keys`, () => {
      const missing = [...source.keys()].filter((k) => !messages.has(k))
      const extra = [...messages.keys()].filter((k) => !source.has(k))
      expect({ missing, extra }).toEqual({ missing: [], extra: [] })
    })

    it(`${locale} uses the same placeholders as English`, () => {
      const mismatched = [...source]
        .filter(([key, en]) => messages.has(key) && placeholdersOf(en).join() !== placeholdersOf(messages.get(key)!).join())
        .map(([key]) => key)
      expect(mismatched).toEqual([])
    })

    it(`${locale} has no empty messages`, () => {
      expect([...messages].filter(([, text]) => !text.trim()).map(([key]) => key)).toEqual([])
    })
  }

  it("has no empty English messages", () => {
    expect([...source].filter(([, text]) => !text.trim()).map(([key]) => key)).toEqual([])
  })
})

describe("helpers", () => {
  it("fills placeholders and leaves unknown ones", () => {
    expect(interpolate("Remove {name}? {other}", { name: "web" })).toBe("Remove web? {other}")
    expect(placeholdersOf("{b} and {a} and {b}")).toEqual(["a", "b"])
  })

  it("picks plural forms per language", () => {
    const entry = { one: "{count} container", other: "{count} containers" }
    expect(i18nFor("en").plural(entry, 1)).toBe("1 container")
    expect(i18nFor("en").plural(entry, 2)).toBe("2 containers")
    // Indonesian has no grammatical plural: always the "other" form.
    expect(i18nFor("id").plural(entry, 1)).toBe("1 containers")
  })

  it("keeps the English number formats and localizes the others", () => {
    expect(formatBytes(1536)).toBe("1.5 KB")
    expect(i18nFor("en").formatBytes(1536)).toBe("1.5 KB")
    expect(i18nFor("id").formatBytes(1536)).toBe("1,5 KB")
    expect(i18nFor("id").formatNumber(1234567)).toBe("1.234.567")
  })

  it("renders rich placeholders as nodes", () => {
    const nodes = i18nFor("en").rich("Run {cmd} now", { cmd: "docker ps" }) as unknown[]
    expect(nodes).toHaveLength(3)
    expect(nodes[0]).toBe("Run ")
  })
})
