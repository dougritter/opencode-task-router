import assert from "node:assert/strict"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { execFileSync } from "node:child_process"

const __filename = fileURLToPath(import.meta.url)
const root = path.resolve(path.dirname(__filename), "..")
const packageName = "opencode-task-router"

function run(command, args, cwd, options = {}) {
  return execFileSync(command, args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  })
}

const workspace = mkdtempSync(path.join(os.tmpdir(), "opencode-task-router-"))
const originalFetch = globalThis.fetch

try {
  run("npm", ["run", "build"], root)

  const packOutput = run(
    "npm",
    ["pack", "--json", "--pack-destination", workspace],
    root,
  )
  const packResult = JSON.parse(packOutput)
  const tarball = path.join(workspace, packResult[0].filename)

  writeFileSync(
    path.join(workspace, "package.json"),
    JSON.stringify({ name: "smoke-test", private: true }, null, 2),
  )
  run(
    "npm",
    ["install", tarball, "@opencode-ai/plugin@1.2.27"],
    workspace,
  )

  const installedRoot = path.join(workspace, "node_modules", packageName)
  assert.ok(existsSync(path.join(installedRoot, "dist", "index.js")))
  assert.ok(existsSync(path.join(installedRoot, "examples", "opencode", "opencode.json")))
  assert.ok(
    existsSync(
      path.join(installedRoot, "examples", "opencode", ".opencode", "commands", "route.md"),
    ),
  )

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
              reasoning: "A focused one-file task works well on a local model.",
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

    throw new Error(`Unexpected fetch URL: ${url}`)
  }

  const mod = await import(pathToFileURL(path.join(installedRoot, "dist", "index.js")).href)
  assert.equal(typeof mod.default, "function")
  assert.equal(typeof mod.TaskRouterPlugin, "function")

  const projectDir = path.join(workspace, "project")
  mkdirSync(projectDir, { recursive: true })

  const hooks = await mod.default({ directory: projectDir, worktree: projectDir })
  assert.ok(hooks.tool)
  assert.ok(hooks.event)
  assert.ok(hooks.tool.route_task)

  const recommendation = await hooks.tool.route_task.execute(
    { prompt: "rename a function in one file" },
    { directory: projectDir, worktree: projectDir, sessionID: "session-1" },
  )

  assert.match(recommendation, /Task Routing Recommendation/)
  assert.match(recommendation, /Cost tier \| \*\*free\*\*/)

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

  const historyPath = path.join(projectDir, ".opencode", "router-history.jsonl")
  assert.ok(existsSync(historyPath))
  const history = readFileSync(historyPath, "utf8")
  assert.match(history, /recommendedTier":"free"/)
  assert.match(history, /actualModel":"ollama\/qwen3:8b"/)
  console.log("Smoke test passed")
} finally {
  globalThis.fetch = originalFetch
  rmSync(workspace, { recursive: true, force: true })
}
