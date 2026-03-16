# OpenCode Task Router Plugin - Implementation Plan

## Overview

An OpenCode plugin that adds a `/route` command and a `route_task` custom tool. When you write a prompt, you invoke `/route` and the plugin:

1. Sends your prompt to a **local Ollama model** (`qwen3:8b`) for classification
2. The local model evaluates **task complexity**, **estimated context needs**, and **cost implications**
3. Returns a **tier-based recommendation** (free / cheap / moderate / expensive)
4. You confirm by switching agent/model, and the plugin **implicitly observes your choice**
5. The decision is logged to a history file for future few-shot calibration

## Architecture

```
                    You type: /route "Implement feature X"
                                    |
                                    v
                        +---------------------------+
                        |   /route command           |
                        |   (sends to build          |
                        |    agent as prompt)         |
                        +-------------+-------------+
                                      |
                                      v
                        +---------------------------+
                        |   route_task tool          |
                        |   1. Read history          |
                        |   2. Build classifier      |
                        |      prompt                |
                        |   3. Call Ollama            |
                        |   4. Store pending          |
                        |      recommendation        |
                        |   5. Return result          |
                        +-------------+-------------+
                                      |
                                      v
                        +---------------------------+
                        |   You see the              |
                        |   recommendation and       |
                        |   proceed with your        |
                        |   work (Tab to switch      |
                        |   agent, /models, or       |
                        |   just keep going)         |
                        +-------------+-------------+
                                      |
                                      v
                        +---------------------------+
                        |   message.updated +        |
                        |   session.idle hooks       |
                        |                            |
                        |   message.updated tracks   |
                        |   which model/agent was    |
                        |   actually used per        |
                        |   session. session.idle     |
                        |   fires when the session   |
                        |   goes idle — the plugin   |
                        |   compares recommendation  |
                        |   vs actual tier and logs. |
                        +---------------------------+
```

## Design Decisions

### Model Choice: `qwen3:8b`

- **Why:** Best balance of structured JSON output, few-shot learning ability, and speed for classification tasks.
- **Alternatives:** `llama3.2:3b` (faster, less reliable JSON), `qwen3:14b` (better quality, more VRAM).
- **Context window:** 32K — enough for ~20 historical examples plus the task prompt.

### Learning Strategy: Implicit Observation

- The plugin logs what was recommended **and** what model/agent was actually used.
- No explicit confirmation step — minimal friction.
- The `message.updated` event hook tracks which `providerID`/`modelID`/`agent` was used per session.
- When `session.idle` fires, the plugin infers the actual cost tier from the model used and compares it to the recommendation.
- On each `/route` call, the last 20 decisions are injected as few-shot examples.
- Over time, the classifier naturally adapts to your preferences.

### Routing Tiers (Tier-Only Recommendations)

The plugin **does NOT interact with OpenCode's model/provider system**. It recommends
cost tiers, and you pick the specific model via `/models` or agent switching.

> **Critical constraint:** `client.config.providers()` must NEVER be called. It causes
> OpenCode to persist a model selection that can break the project. See Discoveries
> in `README.md` for details.

Instead, the plugin infers cost tiers from model IDs using regex heuristics when
observing what was actually used:

| Cost Tier | Example Models | Agent |
|-----------|----------------|-------|
| free | Any `ollama/*` provider, `lmstudio`, `llama.cpp` | `local-worker` |
| cheap | `haiku`, `gpt-4o-mini`, `gemini-flash`, `nano` | `build` |
| moderate | `sonnet`, `gpt-4o`, `codex`, `claude-3.5`, `gemini-pro` | `build` |
| expensive | `opus`, `gpt-5`, `o1-pro`, `gemini-ultra` | `build` |

This means the plugin works with **any combination of providers** — you don't
need Anthropic specifically. It will observe whatever you have configured.

## Implicit Learning Loop

The learning loop works through two event hooks:

1. **`message.updated`** — fires for every message. The plugin extracts `providerID`,
   `modelID`, and `agent` (from `UserMessage`) or `mode` (from `AssistantMessage`)
   and stores them in an in-memory map keyed by `sessionID`.

2. **`session.idle`** — fires when the session goes idle. If there's a pending
   recommendation, the plugin:
   - Looks up which model was actually used in this session
   - Infers the actual cost tier from the provider/model IDs
   - Compares against the recommendation
   - Logs the result with `accepted: true` (tiers match) or `accepted: false` (tiers differ)
   - Records the `actualTier` for richer history

History entries look like:

```json
{
  "ts": "2026-03-16T10:00:00.000Z",
  "prompt": "Fix the typo in README.md",
  "recommendedTier": "free",
  "accepted": true,
  "actualTier": "free",
  "actualModel": "ollama/qwen3:8b"
}
```

When `accepted` is `false`, the few-shot examples tell the classifier:
> "For this kind of task, the developer overrode your recommendation and used a different tier."

This creates a feedback signal that calibrates future classifications.

## File Structure

```
.opencode/
  plugins/
    task-router.ts          # Main plugin: tool + event hooks + history
  commands/
    route.md                # /route slash command
  agents/
    local-worker.md         # Agent for simple tasks (Ollama)
  router-history.jsonl      # Auto-generated, append-only log
  package.json              # @opencode-ai/plugin dependency
opencode.json               # Ollama provider configuration
```

## Prerequisites

1. Ollama installed: `brew install ollama`
2. Ollama running: `ollama serve`
3. Model pulled: `ollama pull qwen3:8b`
4. `ollama` added to `enabled_providers` in your OpenCode config
5. At least one paid provider configured in OpenCode (GitHub Copilot, Anthropic, OpenAI, etc.)

## Risks and Mitigations

| Risk | Mitigation |
|------|-----------|
| Ollama not running | Catch fetch error, return helpful message |
| Invalid JSON from classifier | Try/catch, retry once, fall back to "moderate" |
| History file grows unbounded | Only read last 20 entries |
| session.idle fires before model switch | Short delay before logging |
| Misattributed overrides | Acceptable noise — averages out over many decisions |
| `client.config.providers()` causes side effects | Never call it — use tier-only recommendations with model inference from events |

## Future Enhancements (V2)

- **Task decomposition** — split complex work into subtasks for different models
- **Automatic dispatch** — use `tool.execute.before` hook to auto-route
- **Cost tracking** — log estimated vs. actual token usage
- **Explicit routing rules** — config file for pattern-based overrides
- **History summarization** — periodically compress history into meta-rules
