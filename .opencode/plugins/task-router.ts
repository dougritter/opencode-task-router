import { type Plugin, tool } from "@opencode-ai/plugin"
import { readFileSync, appendFileSync, existsSync } from "fs"
import { join } from "path"

/**
 * OpenCode Task Router Plugin
 *
 * Analyzes task prompts using a local Ollama model and recommends
 * the appropriate cost tier and agent. Learns from your routing
 * decisions over time via implicit observation.
 *
 * Does NOT interact with OpenCode's model/provider system to avoid
 * side effects. Recommendations are tier-based -- you pick the
 * specific model yourself via /models.
 *
 * Learning loop: message.updated events track which model/agent
 * was actually used per session. When session.idle fires, the
 * plugin compares the recommendation to the actual tier and logs
 * the result.
 */

// ── Types ────────────────────────────────────────────────────────────

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

// ── Configuration ────────────────────────────────────────────────────

const OLLAMA_BASE_URL = "http://localhost:11434"
const CLASSIFIER_MODEL = "qwen3:8b"
const HISTORY_FILE = "router-history.jsonl"
const MAX_HISTORY_EXAMPLES = 20

// ── Tier descriptions for the output ─────────────────────────────────

const TIER_INFO: Record<string, { description: string; agent: string }> = {
  free: {
    description: "Local model (Ollama) — zero cost, good for trivial/simple tasks",
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

// ── Tier inference from model/provider IDs ───────────────────────────

/**
 * Infer the cost tier from a provider ID and model ID.
 * Uses regex heuristics on model names -- does NOT call any
 * OpenCode SDK methods to avoid side effects.
 */
function inferTierFromModel(providerID: string, modelID: string): string {
  const provider = providerID.toLowerCase()
  const model = modelID.toLowerCase()

  // Free tier: local model providers
  if (
    provider === "ollama" ||
    provider === "lmstudio" ||
    provider === "llama.cpp" ||
    provider === "llamacpp"
  ) {
    return "free"
  }

  // Expensive tier patterns
  if (/opus|o1-pro|gpt-?5|gemini[.-_]?ultra/.test(model)) {
    return "expensive"
  }

  // Cheap tier patterns
  if (
    /haiku|gpt-?4o-?mini|gemini[.-_]?flash|nano|mini|small/.test(model) &&
    !/sonnet/.test(model)
  ) {
    return "cheap"
  }

  // Moderate tier: everything else from paid providers
  // Matches: sonnet, gpt-4o, codex, claude, gemini-pro, etc.
  return "moderate"
}

// ── History helpers ──────────────────────────────────────────────────

function getHistoryPath(worktree: string): string {
  return join(worktree, ".opencode", HISTORY_FILE)
}

function readHistory(worktree: string): HistoryEntry[] {
  const historyPath = getHistoryPath(worktree)
  if (!existsSync(historyPath)) {
    return []
  }

  try {
    const content = readFileSync(historyPath, "utf-8")
    const lines = content.trim().split("\n").filter(Boolean)
    return lines.slice(-MAX_HISTORY_EXAMPLES).map((line) => JSON.parse(line))
  } catch {
    return []
  }
}

function appendHistory(worktree: string, entry: HistoryEntry): void {
  const historyPath = getHistoryPath(worktree)
  appendFileSync(historyPath, JSON.stringify(entry) + "\n", "utf-8")
}

// ── Classifier prompt builder ────────────────────────────────────────

function buildClassifierPrompt(
  taskPrompt: string,
  history: HistoryEntry[]
): string {
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

  // Inject historical decisions as few-shot calibration
  if (history.length > 0) {
    prompt += `\nHere are recent routing decisions for calibration.
When "accepted" is false, the developer disagreed with the recommendation
and chose a different tier -- adjust your future classifications accordingly:\n\n`

    for (const entry of history) {
      if (entry.accepted === false && entry.actualTier) {
        prompt += `- "${truncate(entry.prompt, 80)}" -> recommended: ${entry.recommendedTier}, OVERRIDDEN -> developer used: ${entry.actualTier}\n`
      } else if (entry.accepted === true) {
        prompt += `- "${truncate(entry.prompt, 80)}" -> recommended: ${entry.recommendedTier}, accepted\n`
      } else {
        // Legacy entries without accepted field
        prompt += `- "${truncate(entry.prompt, 80)}" -> recommended: ${entry.recommendedTier}\n`
      }
    }
    prompt += "\n"
  }

  prompt += `\nNow classify this task:\n${taskPrompt}`

  return prompt
}

function truncate(str: string, maxLen: number): string {
  return str.length > maxLen ? str.slice(0, maxLen) + "..." : str
}

// ── Ollama API call ──────────────────────────────────────────────────

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
  // Strip any markdown fences or thinking tags the model might add
  let cleaned = raw
    .replace(/```json\s*/g, "")
    .replace(/```\s*/g, "")
    .replace(/<think>[\s\S]*?<\/think>/g, "")
    .trim()

  // Try to extract JSON object if there's extra text around it
  const jsonMatch = cleaned.match(/\{[\s\S]*\}/)
  if (jsonMatch) {
    cleaned = jsonMatch[0]
  }

  const parsed = JSON.parse(cleaned)

  // Validate required fields
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

// ── Plugin ───────────────────────────────────────────────────────────

export const TaskRouterPlugin: Plugin = async ({
  client,
  directory,
  worktree,
}) => {
  // In-memory state: tracks the last recommendation so the idle hook
  // can compare it against what the user actually did.
  let pending: PendingRecommendation | null = null

  // Track which model/agent was used per session via message.updated events.
  // This avoids calling client.config.providers() which has known side effects.
  const sessionModels = new Map<string, SessionModelInfo>()

  return {
    // ── Custom tool: route_task ────────────────────────────────────
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

          // 1. Read routing history for few-shot calibration
          const history = readHistory(projectRoot)

          // 2. Build the classifier prompt
          const classifierPrompt = buildClassifierPrompt(args.prompt, history)

          // 3. Call the local Ollama model
          let classification: ClassifierResponse
          try {
            const rawResponse = await callOllama(classifierPrompt)
            classification = parseClassifierResponse(rawResponse)
          } catch (error) {
            // Retry once with a simpler prompt on parse failure
            try {
              const retryPrompt = `Respond with ONLY valid JSON, no other text.\n\n${classifierPrompt}`
              const rawRetry = await callOllama(retryPrompt)
              classification = parseClassifierResponse(rawRetry)
            } catch {
              // Check if Ollama is reachable at all
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

              // Ollama is running but classification failed
              return [
                "## Router Warning",
                "",
                `Classification failed (${error}). Defaulting to **moderate** tier.`,
                "",
                "Run **\`/models\`** to pick a capable paid model, or just continue.",
              ].join("\n")
            }
          }

          const tierInfo = TIER_INFO[classification.costTier]

          // 4. Store as pending for the idle hook to compare later
          pending = {
            ts: new Date().toISOString(),
            prompt: args.prompt,
            tier: classification.costTier,
            sessionID: context.sessionID,
          }

          // 5. Format and return the recommendation
          const historyNote =
            history.length > 0
              ? `*Calibrated from ${history.length} past routing decisions.*`
              : "*No routing history yet — recommendations will improve as you use the router.*"

          // Tier overview
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
            `1. **Switch agent** — press \`Tab\` and select **\`${tierInfo.agent}\`**`,
            `2. **Switch model** — run **\`/models\`** and pick a **${classification.costTier}**-tier model`,
            `3. **Ignore** — just keep working with your current setup if you disagree`,
            "",
            "*Your choice will be observed and used to improve future recommendations.*",
          ].join("\n")
        },
      }),
    },

    // ── Event hooks: observe actual usage after routing ────────────
    event: async ({ event }) => {
      // Track model/agent from message events
      if (event.type === "message.updated") {
        const msg = (event as any).properties?.info
        if (!msg) return

        if (msg.role === "user" && msg.sessionID) {
          // UserMessage carries .agent and .model { providerID, modelID }
          sessionModels.set(msg.sessionID, {
            providerID: msg.model?.providerID || "unknown",
            modelID: msg.model?.modelID || "unknown",
            agent: msg.agent || "unknown",
          })
        } else if (msg.role === "assistant" && msg.sessionID) {
          // AssistantMessage carries .providerID, .modelID, and .mode (agent)
          sessionModels.set(msg.sessionID, {
            providerID: msg.providerID || "unknown",
            modelID: msg.modelID || "unknown",
            agent: msg.mode || "unknown",
          })
        }
      }

      // When session goes idle, compare recommendation to what was actually used
      if (event.type === "session.idle" && pending) {
        try {
          const projectRoot = worktree || directory
          const sessionID = (event as any).properties?.sessionID

          // Look up what model was actually used in this session
          const actualInfo = sessionID
            ? sessionModels.get(sessionID)
            : null

          let accepted: boolean | undefined = undefined
          let actualTier: string | undefined = undefined
          let actualModel: string | undefined = undefined

          if (actualInfo && actualInfo.providerID !== "unknown") {
            actualTier = inferTierFromModel(actualInfo.providerID, actualInfo.modelID)
            actualModel = `${actualInfo.providerID}/${actualInfo.modelID}`
            accepted = actualTier === pending.tier
          }

          const entry: HistoryEntry = {
            ts: pending.ts,
            prompt: truncate(pending.prompt, 200),
            recommendedTier: pending.tier,
            accepted,
            actualTier,
            actualModel,
          }

          appendHistory(projectRoot, entry)

          // Clean up the session model tracking for this session
          if (sessionID) {
            sessionModels.delete(sessionID)
          }
        } catch {
          // Silently ignore logging errors
        } finally {
          pending = null
        }
      }
    },
  }
}
