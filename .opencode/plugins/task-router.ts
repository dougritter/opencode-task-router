import { type Plugin, tool } from "@opencode-ai/plugin"
import { readFileSync, appendFileSync, existsSync } from "fs"
import { join } from "path"

/**
 * OpenCode Task Router Plugin
 *
 * Analyzes task prompts using a local Ollama model and recommends
 * the appropriate model/agent tier. Learns from your routing decisions
 * over time via implicit observation.
 *
 * Dynamically discovers available models from OpenCode's configured
 * providers so it only recommends models you actually have access to.
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

interface AvailableModel {
  id: string // "provider/model" format
  name: string
  tier: "free" | "cheap" | "moderate" | "expensive"
}

interface TierMapping {
  model: string
  agent: string
}

// ── Configuration ────────────────────────────────────────────────────

const OLLAMA_BASE_URL = "http://localhost:11434"
const CLASSIFIER_MODEL = "qwen3:8b"
const HISTORY_FILE = "router-history.jsonl"
const MAX_HISTORY_EXAMPLES = 20

// ── Model classification heuristics ──────────────────────────────────

/**
 * Known provider tiers -- used to classify discovered models.
 * Providers listed here are categorized by their typical cost tier.
 * Models from unknown providers default to "moderate".
 */
const FREE_PROVIDERS = new Set([
  "ollama",
  "lmstudio",
  "llama.cpp",
  "llamacpp",
])

/**
 * Known model patterns and their cost tiers.
 * Matched against the model ID (case-insensitive).
 * More specific patterns should come first.
 */
const MODEL_TIER_PATTERNS: Array<{ pattern: RegExp; tier: AvailableModel["tier"] }> = [
  // Free: local models
  { pattern: /^(ollama|lmstudio|llama\.?cpp)\//i, tier: "free" },

  // Cheap: small/fast models
  { pattern: /haiku/i, tier: "cheap" },
  { pattern: /gpt-?4o-?mini/i, tier: "cheap" },
  { pattern: /gemini.*flash/i, tier: "cheap" },
  { pattern: /claude-3-haiku/i, tier: "cheap" },
  { pattern: /grok.*mini/i, tier: "cheap" },
  { pattern: /deepseek.*chat/i, tier: "cheap" },
  { pattern: /nano/i, tier: "cheap" },

  // Expensive: premium models
  { pattern: /opus/i, tier: "expensive" },
  { pattern: /gpt-?5[^.]|gpt-?5$/i, tier: "expensive" },
  { pattern: /o1-?pro/i, tier: "expensive" },
  { pattern: /gemini.*ultra/i, tier: "expensive" },
  { pattern: /gemini.*pro/i, tier: "expensive" },

  // Moderate: everything else that's paid (sonnet, gpt-4o, codex, etc.)
  { pattern: /sonnet/i, tier: "moderate" },
  { pattern: /gpt-?4o/i, tier: "moderate" },
  { pattern: /gpt-?5\.1/i, tier: "moderate" },
  { pattern: /codex/i, tier: "moderate" },
  { pattern: /claude/i, tier: "moderate" },
  { pattern: /gemini/i, tier: "moderate" },
  { pattern: /deepseek/i, tier: "moderate" },
  { pattern: /grok/i, tier: "moderate" },
]

/**
 * Classify a model into a cost tier based on its provider and model ID.
 */
function classifyModel(providerID: string, modelID: string): AvailableModel["tier"] {
  const fullID = `${providerID}/${modelID}`

  // Check free providers first
  if (FREE_PROVIDERS.has(providerID.toLowerCase())) {
    return "free"
  }

  // Match against known patterns
  for (const { pattern, tier } of MODEL_TIER_PATTERNS) {
    if (pattern.test(fullID) || pattern.test(modelID)) {
      return tier
    }
  }

  // Default to moderate for unknown paid models
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
  history: HistoryEntry[],
  availableModels: AvailableModel[]
): string {
  // Group available models by tier for the prompt
  const modelsByTier: Record<string, string[]> = {
    free: [],
    cheap: [],
    moderate: [],
    expensive: [],
  }
  for (const m of availableModels) {
    modelsByTier[m.tier].push(m.id)
  }

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

IMPORTANT: Only suggest tiers that have available models. Here are the models
the developer has configured:
`

  // List available models per tier
  for (const tier of ["free", "cheap", "moderate", "expensive"]) {
    const models = modelsByTier[tier]
    if (models.length > 0) {
      prompt += `- ${tier}: ${models.join(", ")}\n`
    } else {
      prompt += `- ${tier}: NO MODELS AVAILABLE (do NOT suggest this tier)\n`
    }
  }

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
  // can compare it against what model/agent was actually used.
  let pending: PendingRecommendation | null = null

  // ── Discover available models at startup ──────────────────────────

  let availableModels: AvailableModel[] = []
  let tierMap: Record<string, TierMapping> = {}

  async function discoverModels(): Promise<void> {
    try {
      const result = await client.config.providers()
      const providers = result.data?.providers || result.providers || []
      availableModels = []

      for (const provider of providers as Array<{ id: string; name?: string; models?: Array<{ id: string; name?: string }> }>) {
        const providerID = provider.id
        const models = provider.models || []

        for (const model of models) {
          const modelID = model.id
          const fullID = `${providerID}/${modelID}`
          const tier = classifyModel(providerID, modelID)

          availableModels.push({
            id: fullID,
            name: model.name || modelID,
            tier,
          })
        }
      }

      // Build tier map: pick the first available model per tier
      // Priority within a tier: prefer models we've seen the user accept before
      const tierPriority: Array<AvailableModel["tier"]> = ["free", "cheap", "moderate", "expensive"]
      tierMap = {}

      for (const tier of tierPriority) {
        const modelsInTier = availableModels.filter((m) => m.tier === tier)
        if (modelsInTier.length > 0) {
          tierMap[tier] = {
            model: modelsInTier[0].id,
            agent: tier === "free" ? "local-worker" : "build",
          }
        }
      }

      // If a tier has no models, fall back to the nearest available tier
      for (const tier of tierPriority) {
        if (!tierMap[tier]) {
          // Find the nearest tier that has models (prefer higher capability)
          const fallbackOrder =
            tier === "free"
              ? ["cheap", "moderate", "expensive"]
              : tier === "cheap"
                ? ["moderate", "free", "expensive"]
                : tier === "moderate"
                  ? ["cheap", "expensive", "free"]
                  : ["moderate", "cheap", "free"]

          for (const fallback of fallbackOrder) {
            if (tierMap[fallback]) {
              tierMap[tier] = { ...tierMap[fallback] }
              break
            }
          }
        }
      }
    } catch (error) {
      // If we can't discover models, log and use a minimal fallback
      try {
        await client.app.log({
          body: {
            service: "task-router",
            level: "warn",
            message: `Failed to discover models: ${error}. Recommendations may be inaccurate.`,
          },
        })
      } catch {
        // Ignore logging errors
      }
    }
  }

  // Discover models on plugin init
  await discoverModels()

  return {
    // ── Custom tool: route_task ────────────────────────────────────
    tool: {
      route_task: tool({
        description:
          "Analyze a development task and recommend the best model/agent to use. " +
          "Evaluates task complexity, context size needs, and cost tier. " +
          "Only suggests models that are actually available in your configuration. " +
          "Call this before starting work to optimize model selection. " +
          "Uses a local Ollama model for classification (zero cost).",
        args: {
          prompt: tool.schema
            .string()
            .describe("The task description or prompt to analyze for routing"),
        },
        async execute(args, context) {
          const projectRoot = context.worktree || context.directory

          // Refresh available models in case providers changed
          await discoverModels()

          if (availableModels.length === 0) {
            return [
              "## Router Error",
              "",
              "No models discovered from OpenCode providers.",
              "Make sure you have at least one provider configured via `/connect`.",
              "",
              "Run `/models` to see what's available.",
            ].join("\n")
          }

          // 1. Read routing history for few-shot calibration
          const history = readHistory(projectRoot)

          // 2. Build the classifier prompt (now includes available models)
          const classifierPrompt = buildClassifierPrompt(
            args.prompt,
            history,
            availableModels
          )

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

              // Ollama is running but classification failed -- use fallback
              const fallbackTier = tierMap.moderate || tierMap.cheap || tierMap.free
              const fallbackModel = fallbackTier?.model || "unknown"
              const fallbackAgent = fallbackTier?.agent || "build"

              return [
                "## Router Warning",
                "",
                `Classification failed (${error}). Defaulting to best available model.`,
                "",
                "| Factor | Assessment |",
                "|--------|-----------|",
                `| Suggested model | \`${fallbackModel}\` |`,
                `| Suggested agent | \`${fallbackAgent}\` |`,
                "",
                "Switch model with `/models` or agent with **Tab**.",
              ].join("\n")
            }
          }

          // 4. Ensure the suggested tier has models; fall back if not
          if (!tierMap[classification.costTier]) {
            // Fallback: find the nearest available tier
            const fallbackOrder = ["moderate", "cheap", "expensive", "free"]
            for (const fb of fallbackOrder) {
              if (tierMap[fb]) {
                classification.costTier = fb as ClassifierResponse["costTier"]
                break
              }
            }
          }

          const tier = tierMap[classification.costTier]
          if (!tier) {
            return [
              "## Router Error",
              "",
              "No models available in any tier. Configure providers with `/connect`.",
            ].join("\n")
          }

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

          // Show all available models grouped by tier
          const modelListLines: string[] = ["", "**Available models by tier:**", ""]
          for (const t of ["free", "cheap", "moderate", "expensive"]) {
            const models = availableModels.filter((m) => m.tier === t)
            if (models.length > 0) {
              const marker = t === recommendation.costTier ? " <--" : ""
              modelListLines.push(
                `- **${t}**: ${models.map((m) => `\`${m.id}\``).join(", ")}${marker}`
              )
            }
          }

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
            ...modelListLines,
            "",
            "---",
            "",
            "### How to proceed",
            "",
            `1. **Switch agent** — press \`Tab\` and select **\`${recommendation.suggestedAgent}\`**`,
            `2. **Switch model** — run **\`/models\`** and pick **\`${recommendation.suggestedModel}\`**`,
            `3. **Ignore** — just keep working with your current setup if you disagree`,
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
          pending = null
        }
      }
    },
  }
}
