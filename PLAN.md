# OpenCode Task Router Plugin - Implementation Plan

## Overview

An OpenCode plugin that adds a `/route` command and a `route_task` custom tool. When you write a prompt, you invoke `/route` and the plugin:

1. Sends your prompt to a **local Ollama model** (`qwen3:8b`) for classification
2. The local model evaluates **task complexity**, **estimated context needs**, and **cost implications**
3. Returns a recommendation of which agent+model to use (local vs. paid)
4. You confirm by switching agent/model, and the plugin implicitly observes your choice
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
                        |   session.idle hook        |
                        |   Observes what model/     |
                        |   agent was actually       |
                        |   used. Compares to        |
                        |   recommendation.          |
                        |   Logs to history.         |
                        +---------------------------+
```

## Design Decisions

### Model Choice: `qwen3:8b`

- **Why:** Best balance of structured JSON output, few-shot learning ability, and speed for classification tasks.
- **Alternatives:** `llama3.2:3b` (faster, less reliable JSON), `qwen3:14b` (better quality, more VRAM).
- **Context window:** 32K -- enough for ~20 historical examples plus the task prompt.

### Learning Strategy: Implicit Observation

- The plugin logs what was recommended vs. what model/agent was actually used.
- No explicit confirmation step -- minimal friction.
- On each `/route` call, the last 20 decisions are injected as few-shot examples.
- Over time, the classifier naturally adapts to your preferences.

### Routing Tiers

| Cost Tier | Model | Agent | Use Case |
|-----------|-------|-------|----------|
| free | `ollama/qwen3:8b` | `local-worker` | Trivial/simple tasks |
| cheap | `anthropic/claude-haiku-4-20250514` | `build` | Moderate tasks |
| moderate | `anthropic/claude-sonnet-4-20250514` | `build` | Complex features |
| expensive | `anthropic/claude-opus-4-20250514` | `build` | Architecture-level work |

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
opencode.json               # Ollama provider configuration
```

## Prerequisites

1. Ollama installed: `brew install ollama`
2. Ollama running: `ollama serve`
3. Model pulled: `ollama pull qwen3:8b`
4. At least one paid provider configured in OpenCode (Anthropic, OpenAI, etc.)

## Risks and Mitigations

| Risk | Mitigation |
|------|-----------|
| Ollama not running | Catch fetch error, return helpful message |
| Invalid JSON from classifier | Try/catch, retry once, fall back to "moderate" |
| History file grows unbounded | Only read last 20 entries |
| session.idle fires before model switch | Short delay before logging |
| Misattributed overrides | Acceptable noise -- averages out over many decisions |

## Future Enhancements (V2)

- **Task decomposition** -- split complex work into subtasks for different models
- **Automatic dispatch** -- use `tool.execute.before` hook to auto-route
- **Cost tracking** -- log estimated vs. actual token usage
- **Explicit routing rules** -- config file for pattern-based overrides
- **History summarization** -- periodically compress history into meta-rules
