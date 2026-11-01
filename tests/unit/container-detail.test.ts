import { describe, expect, it } from "vitest"

import {
  commandLine,
  exposedPortNumbers,
  initialContainerTab,
  portBindingLines,
  proxyDomainUrl,
  splitEnvEntry,
} from "@/lib/container-detail"

describe("container page helpers", () => {
  it("lists published port bindings", () => {
    expect(
      portBindingLines({
        "80/tcp": [
          { HostIp: "", HostPort: "8080" },
          { HostIp: "127.0.0.1", HostPort: "8081" },
        ],
        "53/udp": [{ HostIp: "::", HostPort: "5353" }],
        "9000/tcp": null,
      })
    ).toEqual(["8080 → 80/tcp", "127.0.0.1:8081 → 80/tcp", ":::5353 → 53/udp"])
    expect(portBindingLines(null)).toEqual([])
    expect(portBindingLines(undefined)).toEqual([])
  })

  it("collects exposed port numbers once per number", () => {
    expect(exposedPortNumbers({ "80/tcp": {}, "80/udp": {}, "443/tcp": {} })).toEqual([80, 443])
    expect(exposedPortNumbers({ "bogus/tcp": {} })).toEqual([])
    expect(exposedPortNumbers(null)).toEqual([])
  })

  it("links proxied domains", () => {
    expect(proxyDomainUrl({ tls: "off" }, "app.example.com")).toBe("http://app.example.com")
    expect(proxyDomainUrl({ tls: "auto" }, "app.example.com")).toBe("https://app.example.com")
    expect(proxyDomainUrl({ tls: "auto" }, "*.example.com")).toBe("https://www.example.com")
  })

  it("splits environment entries at the first =", () => {
    expect(splitEnvEntry("A=1")).toEqual({ key: "A", value: "1" })
    expect(splitEnvEntry("URL=postgres://u:p@h/db?x=y")).toEqual({ key: "URL", value: "postgres://u:p@h/db?x=y" })
    expect(splitEnvEntry("EMPTY=")).toEqual({ key: "EMPTY", value: "" })
    expect(splitEnvEntry("FLAG")).toEqual({ key: "FLAG", value: "" })
  })

  it("joins entrypoint and command", () => {
    expect(commandLine(["/docker-entrypoint.sh"], ["nginx", "-g", "daemon off;"])).toBe("/docker-entrypoint.sh nginx -g daemon off;")
    expect(commandLine(null, ["sh"])).toBe("sh")
    expect(commandLine(null, null)).toBe("—")
    expect(commandLine([], [])).toBe("—")
  })

  it("opens the tab asked for, the console for managers only", () => {
    expect(initialContainerTab(undefined, true)).toBe("logs")
    expect(initialContainerTab("files", false)).toBe("files")
    expect(initialContainerTab("console", true)).toBe("console")
    expect(initialContainerTab("console", false)).toBe("logs")
    expect(initialContainerTab(["console"], true)).toBe("logs")
    expect(initialContainerTab("bogus", true)).toBe("logs")
  })
})
