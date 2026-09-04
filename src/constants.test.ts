import { describe, it, expect } from "vitest"
import {
  ANTIGRAVITY_ENDPOINT,
  ANTIGRAVITY_ENDPOINT_AUTOPUSH,
  ANTIGRAVITY_ENDPOINT_DAILY,
  ANTIGRAVITY_ENDPOINT_FALLBACKS,
  ANTIGRAVITY_ENDPOINT_PROD,
  GEMINI_CLI_HEADERS,
  getAntigravityHeaders,
  getRandomizedHeaders,
  type HeaderSet,
} from "./constants"

describe("GEMINI_CLI_HEADERS", () => {
  it("matches Code Assist headers from opencode-gemini-auth", () => {
    expect(GEMINI_CLI_HEADERS).toEqual({
      "User-Agent": "google-api-nodejs-client/9.15.1",
      "X-Goog-Api-Client": "gl-node/22.17.0",
      "Client-Metadata": '{"ideType":"ANTIGRAVITY","platform":"PLATFORM_UNSPECIFIED","pluginType":"GEMINI"}',
    })
  })
})

describe("getAntigravityHeaders", () => {
  it("returns Client-Metadata with PLATFORM_UNSPECIFIED platform and ANTIGRAVITY ideType", () => {
    const headers = getAntigravityHeaders()
    const metadata = JSON.parse(headers["Client-Metadata"])
    expect(metadata.platform).toBe("PLATFORM_UNSPECIFIED")
    expect(metadata.ideType).toBe("ANTIGRAVITY")
  })
})

describe("getRandomizedHeaders", () => {
  describe("gemini-cli style", () => {
    it("returns static Code Assist headers", () => {
      const headers = getRandomizedHeaders("gemini-cli", "gemini-2.5-pro")
      expect(headers).toEqual({
        "User-Agent": "google-api-nodejs-client/9.15.1",
        "X-Goog-Api-Client": "gl-node/22.17.0",
        "Client-Metadata": '{"ideType":"ANTIGRAVITY","platform":"PLATFORM_UNSPECIFIED","pluginType":"GEMINI"}',
      })
    })

    it("ignores requested model and keeps static User-Agent", () => {
      const headers = getRandomizedHeaders("gemini-cli", "gemini-3-pro-preview")
      expect(headers["User-Agent"]).toBe("google-api-nodejs-client/9.15.1")
    })
  })

  describe("antigravity style", () => {
    it("returns all three headers", () => {
      const headers = getRandomizedHeaders("antigravity")
      expect(headers["User-Agent"]).toBeDefined()
      expect(headers["X-Goog-Api-Client"]).toBeDefined()
      expect(headers["Client-Metadata"]).toBeDefined()
    })

    it("returns User-Agent in antigravity format", () => {
      const headers = getRandomizedHeaders("antigravity")
      expect(headers["User-Agent"]).toMatch(/^antigravity\//)
    })

    it("sets Client-Metadata platform to PLATFORM_UNSPECIFIED and ideType to ANTIGRAVITY", () => {
      for (let i = 0; i < 50; i++) {
        const headers = getRandomizedHeaders("antigravity")
        const metadata = JSON.parse(headers["Client-Metadata"]!)
        expect(metadata.platform).toBe("PLATFORM_UNSPECIFIED")
        expect(metadata.ideType).toBe("ANTIGRAVITY")
      }
    })

    it("never produces a linux User-Agent", () => {
      for (let i = 0; i < 50; i++) {
        const headers = getRandomizedHeaders("antigravity")
        expect(headers["User-Agent"]).not.toMatch(/linux\//)
      }
    })
  })
})

describe("HeaderSet type", () => {
  it("allows omitting X-Goog-Api-Client and Client-Metadata", () => {
    const headers: HeaderSet = {
      "User-Agent": "test",
    }
    expect(headers["User-Agent"]).toBe("test")
    expect(headers["X-Goog-Api-Client"]).toBeUndefined()
    expect(headers["Client-Metadata"]).toBeUndefined()
  })

  it("allows including all three headers", () => {
    const headers: HeaderSet = {
      "User-Agent": "test",
      "X-Goog-Api-Client": "test-client",
      "Client-Metadata": "test-metadata",
    }
    expect(headers["User-Agent"]).toBe("test")
    expect(headers["X-Goog-Api-Client"]).toBe("test-client")
    expect(headers["Client-Metadata"]).toBe("test-metadata")
  })
})

describe("ANTIGRAVITY_ENDPOINT", () => {
  it("defaults to production cloudcode-pa endpoint", () => {
    expect(ANTIGRAVITY_ENDPOINT).toBe(ANTIGRAVITY_ENDPOINT_PROD)
  })
})

describe("ANTIGRAVITY_ENDPOINT_FALLBACKS", () => {
  it("prioritizes PROD followed by DAILY and AUTOPUSH sandboxes", () => {
    expect(ANTIGRAVITY_ENDPOINT_FALLBACKS).toEqual([
      ANTIGRAVITY_ENDPOINT_PROD,
      ANTIGRAVITY_ENDPOINT_DAILY,
      ANTIGRAVITY_ENDPOINT_AUTOPUSH,
    ])
  })
})
