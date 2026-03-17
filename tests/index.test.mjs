import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { fileURLToPath, pathToFileURL } from "node:url"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const root = path.resolve(__dirname, "..")
const mod = await import(pathToFileURL(path.join(root, "dist", "index.js")).href)
const { __testUtils, TaskRouterPlugin } = mod

function withTempDir(fn) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "task-router-test-"))
  return Promise.resolve(fn(dir)).finally(() => {
    rmSync(dir, { recursive: true, force: true })
  })
}

test("inferTierFromModel classifies provider/model combinations", () => {
  assert.equal(__testUtils.inferTierFromModel("ollama", "qwen3:8b"), "free")
  assert.equal(__testUtils.inferTierFromModel("anthropic", "claude-haiku-4-5"), "cheap")
  assert.equal(__testUtils.inferTierFromModel("openai", "gpt-4o"), "moderate")
  assert.equal(__testUtils.inferTierFromModel("anthropic", "claude-opus-4"), "expensive")
})

test("parseClassifierResponse strips wrappers and normalizes invalid values", () => {
  const wrapped = [
    "```json",
    JSON.stringify({
      complexity: "simple",
      contextEstimate: "small",
      costTier: "cheap",
      reasoning: "Small focused work.",
    }),
    "```",
  ].join("\n")

  const parsedWrapped = __testUtils.parseClassifierResponse(wrapped)
  assert.deepEqual(parsedWrapped, {
    complexity: "simple",
    contextEstimate: "small",
    costTier: "cheap",
    reasoning: "Small focused work.",
  })

  const invalid = JSON.stringify({
    complexity: "huge",
    contextEstimate: "tiny",
    costTier: "premium",
  })
  const parsedInvalid = __testUtils.parseClassifierResponse(invalid)
  assert.equal(parsedInvalid.complexity, "moderate")
  assert.equal(parsedInvalid.contextEstimate, "medium")
  assert.equal(parsedInvalid.costTier, "moderate")
  assert.equal(parsedInvalid.reasoning, "No reasoning provided")
})

test("buildClassifierPrompt injects calibration history", () => {
  const prompt = __testUtils.buildClassifierPrompt("rename a helper", [
    {
      ts: "2026-03-17T00:00:00.000Z",
      prompt: "fix typo in readme",
      recommendedTier: "free",
      accepted: true,
    },
    {
      ts: "2026-03-17T00:01:00.000Z",
      prompt: "large auth refactor",
      recommendedTier: "moderate",
      accepted: false,
      actualTier: "expensive",
    },
  ])

  assert.match(prompt, /fix typo in readme/) 
  assert.match(prompt, /accepted/)
  assert.match(prompt, /OVERRIDDEN -> developer used: expensive/)
  assert.match(prompt, /Now classify this task:\nrename a helper/)
})

test("history helpers create and read append-only jsonl", async () => {
  await withTempDir(async (dir) => {
    __testUtils.appendHistory(dir, {
      ts: "2026-03-17T00:00:00.000Z",
      prompt: "one",
      recommendedTier: "free",
    })
    __testUtils.appendHistory(dir, {
      ts: "2026-03-17T00:01:00.000Z",
      prompt: "two",
      recommendedTier: "cheap",
      accepted: false,
      actualTier: "moderate",
    })

    const historyPath = __testUtils.getHistoryPath(dir)
    const raw = readFileSync(historyPath, "utf8")
    assert.match(raw, /"recommendedTier":"free"/)
    assert.match(raw, /"recommendedTier":"cheap"/)

    const history = __testUtils.readHistory(dir)
    assert.equal(history.length, 2)
    assert.equal(history[0].prompt, "one")
    assert.equal(history[1].actualTier, "moderate")
  })
})

test("plugin returns recommendation and logs actual usage on idle", async () => {
  await withTempDir(async (dir) => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = async (url) => {
      if (String(url).includes("/api/generate")) {
        return {
          ok: true,
          async json() {
            return {
              response: JSON.stringify({
                complexity: "simple",
                contextEstimate: "small",
                costTier: "free",
                reasoning: "A one-file change is suitable for a local model.",
              }),
            }
          },
        }
      }

      if (String(url).includes("/api/tags")) {
        return {
          ok: true,
          async json() {
            return { models: [] }
          },
        }
      }

      throw new Error(`Unexpected URL: ${url}`)
    }

    try {
      const hooks = await TaskRouterPlugin({ directory: dir, worktree: dir })
      const output = await hooks.tool.route_task.execute(
        { prompt: "rename a function in one file" },
        { directory: dir, worktree: dir, sessionID: "session-1" },
      )

      assert.match(output, /Task Routing Recommendation/)
      assert.match(output, /\*\*free\*\*/)

      await hooks.event({
        event: {
          type: "message.updated",
          properties: {
            info: {
              role: "assistant",
              sessionID: "session-1",
              providerID: "ollama",
              modelID: "qwen3:8b",
              mode: "local-worker",
            },
          },
        },
      })

      await hooks.event({
        event: {
          type: "session.idle",
          properties: {
            sessionID: "session-1",
          },
        },
      })

      const history = readFileSync(path.join(dir, ".opencode", "router-history.jsonl"), "utf8")
      assert.match(history, /"recommendedTier":"free"/)
      assert.match(history, /"accepted":true/)
      assert.match(history, /"actualModel":"ollama\/qwen3:8b"/)
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})

test("plugin falls back to warning when classifier output keeps failing", async () => {
  await withTempDir(async (dir) => {
    const originalFetch = globalThis.fetch
    let generateCalls = 0

    globalThis.fetch = async (url) => {
      if (String(url).includes("/api/generate")) {
        generateCalls += 1
        return {
          ok: true,
          async json() {
            return { response: "not-json" }
          },
        }
      }

      if (String(url).includes("/api/tags")) {
        return {
          ok: true,
          async json() {
            return { models: [] }
          },
        }
      }

      throw new Error(`Unexpected URL: ${url}`)
    }

    try {
      const hooks = await TaskRouterPlugin({ directory: dir, worktree: dir })
      const output = await hooks.tool.route_task.execute(
        { prompt: "multi-service platform redesign" },
        { directory: dir, worktree: dir, sessionID: "session-2" },
      )

      assert.equal(generateCalls, 2)
      assert.match(output, /Router Warning/)
      assert.match(output, /Defaulting to \*\*moderate\*\* tier/)
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})
