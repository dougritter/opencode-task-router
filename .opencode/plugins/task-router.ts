import { type Plugin, tool } from "@opencode-ai/plugin"
import { readFileSync, appendFileSync, existsSync } from "fs"
import { join } from "path"

/**
 * OpenCode Task Router Plugin
 *
 * Analyzes task prompts using a local Ollama model and recommends
 * the appropriate model/agent tier. Learns from your routing decisions
 * over time via implicit observation.
 */

// ── Types ────────────────────────────────────────────────────────────

interface ClassifierResponse {
  complexity: "trivial" | "simple" | "moderate" | "complex"
  contextEstimate: "small" | "medium" | "large"
  costTier: "free" | "cheap" | "moderate" | "expensive"
  reasoning: string
}

interface RouteRecommendation extends ClassifierResponse {
  suggestedModel: string
  suggestedAgent: string
}

interface HistoryEntry {
  ts: string
  prompt: string
  recommendedTier: string
  recommendedModel: string
  recommendedAgent: string
  actualModel?: string
  accepted?: boolean
}

interface PendingRecommendation {
  ts: string
  prompt: string
  tier: string
  model: string
  agent: string
}

// ── Configuration ────────────────────────────────────────────────────

const OLLAMA_BASE_URL = "http://localhost:11434"
const CLASSIFIER_MODEL = "qwen3:8b"
const HISTORY_FILE = "router-history.jsonl"
const MAX_HISTORY_EXAMPLES = 20

/**
 * Model/agent mapping per cost tier.
 * Customize these to match your configured providers and preferences.
 */
const TIER_MAP: Record<string, { model: string; agent: string }> = {
  free: {
    model: "ollama/qwen3:8b",
    agent: "local-worker",
  },
  cheap: {
    model: "anthropic/claude-haiku-4-20250514",
    agent: "build",
  },
  moderate: {
    model: "anthropic/claude-sonnet-4-20250514",
    agent: "build",
  },
  expensive: {
    model: "anthropic/claude-opus-4-20250514",
    agent: "build",
  },
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
    // Return only the last N entries
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
- free: trivial + simple tasks -> use a local model
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
      const status =
        entry.accepted === false
          ? `OVERRIDDEN (recommended ${entry.recommendedTier}, developer chose differently)`
          : `accepted`
      prompt += `- "${truncate(entry.prompt, 80)}" -> recommended: ${entry.recommendedTier}, ${status}\n`
    }
    prompt += "\n"
  }

  prompt += `Now classify this task:\n${taskPrompt}`

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
  // can compare it against what model/agent was actually used.
  let pending: PendingRecommendation | null = null

  return {
    // ── Custom tool: route_task ────────────────────────────────────
    tool: {
      route_task: tool({
        description:
          "Analyze a development task and recommend the best model/agent to use. " +
          "Evaluates task complexity, context size needs, and cost tier. " +
          "Call this before starting work to optimize model selection. " +
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

              // Ollama is running but classification failed -- fall back
              return [
                "## Router Warning",
                "",
                `Classification failed (${error}). Defaulting to **moderate** tier.`,
                "",
                "| Factor | Assessment |",
                "|--------|-----------|",
                "| Suggested model | `anthropic/claude-sonnet-4-20250514` |",
                "| Suggested agent | `build` |",
                "",
                "Switch model with `/models` or agent with **Tab**.",
              ].join("\n")
            }
          }

          // 4. Map to concrete model/agent
          const tier = TIER_MAP[classification.costTier] || TIER_MAP.moderate
          const recommendation: RouteRecommendation = {
            ...classification,
            suggestedModel: tier.model,
            suggestedAgent: tier.agent,
          }

          // 5. Store as pending for the idle hook to compare later
          pending = {
            ts: new Date().toISOString(),
            prompt: args.prompt,
            tier: recommendation.costTier,
            model: recommendation.suggestedModel,
            agent: recommendation.suggestedAgent,
          }

          // 6. Format and return the recommendation
          const historyNote =
            history.length > 0
              ? `*Calibrated from ${history.length} past routing decisions.*`
              : "*No routing history yet -- recommendations will improve as you use the router.*"

          return [
            "## Task Routing Recommendation",
            "",
            "| Factor | Assessment |",
            "|--------|-----------|",
            `| Complexity | **${recommendation.complexity}** |`,
            `| Context needs | **${recommendation.contextEstimate}** |`,
            `| Cost tier | **${recommendation.costTier}** |`,
            `| Suggested model | \`${recommendation.suggestedModel}\` |`,
            `| Suggested agent | \`${recommendation.suggestedAgent}\` |`,
            "",
            `**Reasoning:** ${recommendation.reasoning}`,
            "",
            historyNote,
            "",
            "---",
            "",
            "**To proceed:**",
            `- Press **Tab** to switch to the \`${recommendation.suggestedAgent}\` agent`,
            `- Or run \`/models\` to select \`${recommendation.suggestedModel}\``,
            "- Or just continue with your current setup if you disagree",
            "",
            "*Your choice will be observed and used to improve future recommendations.*",
          ].join("\n")
        },
      }),
    },

    // ── Event hook: observe actual model usage after routing ───────
    event: async ({ event }) => {
      // When a session goes idle after a routing recommendation,
      // log whether the user followed the recommendation or overrode it.
      if (event.type === "session.idle" && pending) {
        try {
          const projectRoot = worktree || directory

          // Try to detect the model that was actually used.
          // The session.idle event payload may include session info.
          // We compare the recommended model against what was used.
          const sessionEvent = event as { properties?: Record<string, unknown> }
          const actualModel =
            (sessionEvent.properties?.model as string) || "unknown"

          const accepted =
            actualModel === "unknown" || actualModel === pending.model

          const entry: HistoryEntry = {
            ts: pending.ts,
            prompt: truncate(pending.prompt, 200),
            recommendedTier: pending.tier,
            recommendedModel: pending.model,
            recommendedAgent: pending.agent,
            actualModel,
            accepted,
          }

          appendHistory(projectRoot, entry)
        } catch {
          // Silently ignore logging errors -- don't disrupt the user
        } finally {
          // Clear the pending recommendation
          pending = null
        }
      }
    },
  }
}
