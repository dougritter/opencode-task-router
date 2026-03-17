import { type Plugin, tool } from "@opencode-ai/plugin"
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs"
import { join } from "node:path"

interface ClassifierResponse {
  complexity: "trivial" | "simple" | "moderate" | "complex"
  contextEstimate: "small" | "medium" | "large"
  costTier: "free" | "cheap" | "moderate" | "expensive"
  reasoning: string
}

interface HistoryEntry {
  ts: string
  prompt: string
  recommendedTier: string
  accepted?: boolean
  actualTier?: string
  actualModel?: string
}

interface PendingRecommendation {
  ts: string
  prompt: string
  tier: string
  sessionID: string
}

interface SessionModelInfo {
  providerID: string
  modelID: string
  agent: string
}

const OLLAMA_BASE_URL = "http://localhost:11434"
const CLASSIFIER_MODEL = "qwen3:8b"
const HISTORY_DIR = ".opencode"
const HISTORY_FILE = "router-history.jsonl"
const MAX_HISTORY_EXAMPLES = 20

const TIER_INFO: Record<string, { description: string; agent: string }> = {
  free: {
    description: "Local model (Ollama) -- zero cost, good for trivial/simple tasks",
    agent: "local-worker",
  },
  cheap: {
    description: "Fast paid model (e.g. Haiku, GPT-4o Mini, Gemini Flash)",
    agent: "build",
  },
  moderate: {
    description: "Capable paid model (e.g. Sonnet, GPT-4o, Codex)",
    agent: "build",
  },
  expensive: {
    description: "Premium paid model (e.g. Opus, GPT-5, o1-pro)",
    agent: "build",
  },
}

function inferTierFromModel(providerID: string, modelID: string): string {
  const provider = providerID.toLowerCase()
  const model = modelID.toLowerCase()

  if (
    provider === "ollama" ||
    provider === "lmstudio" ||
    provider === "llama.cpp" ||
    provider === "llamacpp"
  ) {
    return "free"
  }

  if (/opus|o1-pro|gpt-?5|gemini[.-_]?ultra/.test(model)) {
    return "expensive"
  }

  if (
    /haiku|gpt-?4o-?mini|gemini[.-_]?flash|nano|mini|small/.test(model) &&
    !/sonnet/.test(model)
  ) {
    return "cheap"
  }

  return "moderate"
}

function getHistoryDir(worktree: string): string {
  return join(worktree, HISTORY_DIR)
}

function getHistoryPath(worktree: string): string {
  return join(getHistoryDir(worktree), HISTORY_FILE)
}

function readHistory(worktree: string): HistoryEntry[] {
  const historyPath = getHistoryPath(worktree)
  if (!existsSync(historyPath)) {
    return []
  }

  try {
    const content = readFileSync(historyPath, "utf-8")
    const trimmed = content.trim()
    if (!trimmed) {
      return []
    }

    return trimmed
      .split("\n")
      .filter(Boolean)
      .slice(-MAX_HISTORY_EXAMPLES)
      .map((line: string) => JSON.parse(line))
  } catch {
    return []
  }
}

function appendHistory(worktree: string, entry: HistoryEntry): void {
  const historyDir = getHistoryDir(worktree)
  if (!existsSync(historyDir)) {
    mkdirSync(historyDir, { recursive: true })
  }

  appendFileSync(getHistoryPath(worktree), JSON.stringify(entry) + "\n", "utf-8")
}

function buildClassifierPrompt(taskPrompt: string, history: HistoryEntry[]): string {
  let prompt = `You are a task classifier for software development work.
Your job is to analyze a task description and classify it so the developer
can pick the right AI model (local/free vs. paid/premium).

Respond with ONLY a valid JSON object. No markdown fences, no explanation
outside the JSON. Do not use any thinking tags.

The JSON must have exactly these fields:
{
  "complexity": "trivial" | "simple" | "moderate" | "complex",
  "contextEstimate": "small" | "medium" | "large",
  "costTier": "free" | "cheap" | "moderate" | "expensive",
  "reasoning": "one sentence explaining your classification"
}

Classification rules:
- trivial: typos, small text edits, renaming, formatting
- simple: single-file fixes, small scripts, doc edits, straightforward questions
- moderate: new features, multi-file refactors, bug fixes requiring investigation
- complex: architecture changes, security-sensitive work, multi-system integration

Context size rules:
- small (<2K tokens of codebase context needed): simple lookups, isolated changes
- medium (2K-20K tokens): moderate features, understanding a module
- large (20K+ tokens): cross-cutting changes, architectural understanding

Cost tier mapping:
- free: trivial + simple tasks -> use a local model (zero cost)
- cheap: moderate tasks with small context -> use a fast paid model
- moderate: moderate tasks with medium/large context -> use a capable paid model
- expensive: complex tasks -> use a premium paid model
`

  if (history.length > 0) {
    prompt += `
Here are recent routing decisions for calibration.
When "accepted" is false, the developer disagreed with the recommendation
and chose a different tier -- adjust your future classifications accordingly:

`

    for (const entry of history) {
      if (entry.accepted === false && entry.actualTier) {
        prompt += `- "${truncate(entry.prompt, 80)}" -> recommended: ${entry.recommendedTier}, OVERRIDDEN -> developer used: ${entry.actualTier}\n`
        continue
      }

      if (entry.accepted === true) {
        prompt += `- "${truncate(entry.prompt, 80)}" -> recommended: ${entry.recommendedTier}, accepted\n`
        continue
      }

      prompt += `- "${truncate(entry.prompt, 80)}" -> recommended: ${entry.recommendedTier}\n`
    }

    prompt += "\n"
  }

  prompt += `\nNow classify this task:\n${taskPrompt}`
  return prompt
}

function truncate(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength)}...` : value
}

async function callOllama(prompt: string): Promise<string> {
  const response = await fetch(`${OLLAMA_BASE_URL}/api/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: CLASSIFIER_MODEL,
      prompt,
      stream: false,
      options: {
        temperature: 0.1,
        num_predict: 256,
      },
    }),
  })

  if (!response.ok) {
    throw new Error(`Ollama returned ${response.status}: ${response.statusText}`)
  }

  const data = (await response.json()) as { response: string }
  return data.response
}

function parseClassifierResponse(raw: string): ClassifierResponse {
  let cleaned = raw
    .replace(/```json\s*/g, "")
    .replace(/```\s*/g, "")
    .replace(/<think>[\s\S]*?<\/think>/g, "")
    .trim()

  const jsonMatch = cleaned.match(/\{[\s\S]*\}/)
  if (jsonMatch) {
    cleaned = jsonMatch[0]
  }

  const parsed = JSON.parse(cleaned)
  const validComplexity = ["trivial", "simple", "moderate", "complex"]
  const validContext = ["small", "medium", "large"]
  const validCost = ["free", "cheap", "moderate", "expensive"]

  if (!validComplexity.includes(parsed.complexity)) {
    parsed.complexity = "moderate"
  }

  if (!validContext.includes(parsed.contextEstimate)) {
    parsed.contextEstimate = "medium"
  }

  if (!validCost.includes(parsed.costTier)) {
    parsed.costTier = "moderate"
  }

  return {
    complexity: parsed.complexity,
    contextEstimate: parsed.contextEstimate,
    costTier: parsed.costTier,
    reasoning: parsed.reasoning || "No reasoning provided",
  }
}

export const __testUtils = {
  buildClassifierPrompt,
  callOllama,
  getHistoryDir,
  getHistoryPath,
  inferTierFromModel,
  parseClassifierResponse,
  readHistory,
  appendHistory,
  truncate,
}

export const TaskRouterPlugin: Plugin = async ({ directory, worktree }) => {
  let pending: PendingRecommendation | null = null
  const sessionModels = new Map<string, SessionModelInfo>()

  return {
    tool: {
      route_task: tool({
        description:
          "Analyze a development task and recommend the best cost tier " +
          "(free/cheap/moderate/expensive) and agent to use. " +
          "Evaluates task complexity, context size needs, and cost implications. " +
          "Uses a local Ollama model for classification (zero cost).",
        args: {
          prompt: tool.schema
            .string()
            .describe("The task description or prompt to analyze for routing"),
        },
        async execute(args, context) {
          const projectRoot = context.worktree || context.directory
          const history = readHistory(projectRoot)
          const classifierPrompt = buildClassifierPrompt(args.prompt, history)

          let classification: ClassifierResponse
          try {
            const rawResponse = await callOllama(classifierPrompt)
            classification = parseClassifierResponse(rawResponse)
          } catch (error) {
            try {
              const retryPrompt = `Respond with ONLY valid JSON, no other text.\n\n${classifierPrompt}`
              const rawRetry = await callOllama(retryPrompt)
              classification = parseClassifierResponse(rawRetry)
            } catch {
              try {
                await fetch(`${OLLAMA_BASE_URL}/api/tags`)
              } catch {
                return [
                  "## Router Error",
                  "",
                  "Cannot connect to Ollama. Make sure it is running:",
                  "```",
                  "ollama serve",
                  "```",
                  "",
                  `And that the model \`${CLASSIFIER_MODEL}\` is pulled:`,
                  "```",
                  `ollama pull ${CLASSIFIER_MODEL}`,
                  "```",
                ].join("\n")
              }

              return [
                "## Router Warning",
                "",
                `Classification failed (${error}). Defaulting to **moderate** tier.`,
                "",
                "Run **`/models`** to pick a capable paid model, or just continue.",
              ].join("\n")
            }
          }

          const tierInfo = TIER_INFO[classification.costTier]

          pending = {
            ts: new Date().toISOString(),
            prompt: args.prompt,
            tier: classification.costTier,
            sessionID: context.sessionID,
          }

          const historyNote = history.length > 0
            ? `*Calibrated from ${history.length} past routing decisions.*`
            : "*No routing history yet -- recommendations will improve as you use the router.*"

          const tierLines: string[] = ["", "**Cost tiers:**", ""]
          for (const [tier, info] of Object.entries(TIER_INFO)) {
            const marker = tier === classification.costTier ? " **<-- recommended**" : ""
            tierLines.push(`- **${tier}**: ${info.description}${marker}`)
          }

          return [
            "## Task Routing Recommendation",
            "",
            "| Factor | Assessment |",
            "|--------|-----------|",
            `| Complexity | **${classification.complexity}** |`,
            `| Context needs | **${classification.contextEstimate}** |`,
            `| Cost tier | **${classification.costTier}** |`,
            "",
            `**Reasoning:** ${classification.reasoning}`,
            "",
            historyNote,
            ...tierLines,
            "",
            "---",
            "",
            "### How to proceed",
            "",
            `1. **Switch agent** -- press \`Tab\` and select **\`${tierInfo.agent}\`**`,
            `2. **Switch model** -- run **\`/models\`** and pick a **${classification.costTier}**-tier model`,
            "3. **Ignore** -- just keep working with your current setup if you disagree",
            "",
            "*Your choice will be observed and used to improve future recommendations.*",
          ].join("\n")
        },
      }),
    },

    event: async ({ event }) => {
      if (event.type === "message.updated") {
        const msg = (event as any).properties?.info
        if (!msg) {
          return
        }

        if (msg.role === "user" && msg.sessionID) {
          sessionModels.set(msg.sessionID, {
            providerID: msg.model?.providerID || "unknown",
            modelID: msg.model?.modelID || "unknown",
            agent: msg.agent || "unknown",
          })
        }

        if (msg.role === "assistant" && msg.sessionID) {
          sessionModels.set(msg.sessionID, {
            providerID: msg.providerID || "unknown",
            modelID: msg.modelID || "unknown",
            agent: msg.mode || "unknown",
          })
        }
      }

      if (event.type === "session.idle" && pending) {
        try {
          const projectRoot = worktree || directory
          const sessionID = (event as any).properties?.sessionID
          const actualInfo = sessionID ? sessionModels.get(sessionID) : null

          let accepted: boolean | undefined
          let actualTier: string | undefined
          let actualModel: string | undefined

          if (actualInfo && actualInfo.providerID !== "unknown") {
            actualTier = inferTierFromModel(actualInfo.providerID, actualInfo.modelID)
            actualModel = `${actualInfo.providerID}/${actualInfo.modelID}`
            accepted = actualTier === pending.tier
          }

          appendHistory(projectRoot, {
            ts: pending.ts,
            prompt: truncate(pending.prompt, 200),
            recommendedTier: pending.tier,
            accepted,
            actualTier,
            actualModel,
          })

          if (sessionID) {
            sessionModels.delete(sessionID)
          }
        } catch {
          // Ignore history logging failures.
        } finally {
          pending = null
        }
      }
    },
  }
}

export default TaskRouterPlugin
