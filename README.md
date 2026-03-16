# OpenCode Task Router Plugin

An [OpenCode](https://opencode.ai) plugin that analyzes your development tasks using a **local Ollama model** (zero cost) and recommends the optimal cost tier and agent to use -- routing simple tasks to free local models and complex tasks to paid cloud models.

The router learns from your decisions over time by observing which tier you actually use after each recommendation.

## How It Works

```
You type: /route "implement user authentication"
                    |
                    v
        +---------------------------+
        |   Ollama (qwen3:8b)       |
        |   classifies the task     |
        |   locally -- zero cost    |
        +-------------+-------------+
                      |
                      v
        +---------------------------+
        |   Recommendation:         |
        |   complexity: complex     |
        |   tier: expensive         |
        |   -> use a premium model  |
        +-------------+-------------+
                      |
                      v
        +---------------------------+
        |   You switch model/agent  |
        |   (or ignore the advice)  |
        |   -- your choice is       |
        |   logged for future       |
        |   calibration             |
        +---------------------------+
```

### Cost Tiers

| Tier | Description | Suggested Agent |
|------|-------------|-----------------|
| **free** | Local model (Ollama) -- zero cost, trivial/simple tasks | `local-worker` |
| **cheap** | Fast paid model (e.g. Haiku, GPT-4o Mini, Gemini Flash) | `build` |
| **moderate** | Capable paid model (e.g. Sonnet, GPT-4o, Codex) | `build` |
| **expensive** | Premium paid model (e.g. Opus, GPT-5, o1-pro) | `build` |

## Prerequisites

1. **[OpenCode](https://opencode.ai)** installed and configured with at least one provider
2. **[Ollama](https://ollama.ai)** installed and running locally
3. **qwen3:8b** model pulled in Ollama

```bash
# Install Ollama (macOS)
brew install ollama

# Start Ollama
ollama serve

# Pull the classifier model
ollama pull qwen3:8b
```

## Installation

### 1. Copy the plugin files

Clone this repo and copy the `.opencode/` directory and `opencode.json` into your project:

```bash
git clone git@github.com:dougritter/opencode-task-router.git
cp -r opencode-task-router/.opencode /path/to/your/project/
cp opencode-task-router/opencode.json /path/to/your/project/
```

Your project should now have:

```
your-project/
├── opencode.json                 # Ollama provider config
└── .opencode/
    ├── package.json              # Plugin dependencies
    ├── plugins/
    │   └── task-router.ts        # Core plugin
    ├── commands/
    │   └── route.md              # /route slash command
    └── agents/
        └── local-worker.md       # Free-tier agent using Ollama
```

### 2. Add Ollama to your enabled providers

If your global OpenCode config (`~/.config/opencode/opencode.json` or `opencode.jsonc`) uses `enabled_providers`, add `"ollama"` to the list:

```jsonc
{
  "enabled_providers": ["github-copilot", "ollama"]
}
```

This allows OpenCode to use the Ollama models defined in the project-level `opencode.json`.

### 3. Restart OpenCode

OpenCode automatically installs plugin dependencies and loads plugins from `.opencode/plugins/` on startup.

## Usage

### Using the `/route` command

Type `/route` followed by a description of your task:

```
/route fix a typo in the README
```

The router will analyze your task and output a recommendation like:

```
## Task Routing Recommendation

| Factor        | Assessment  |
|---------------|-------------|
| Complexity    | trivial     |
| Context needs | small       |
| Cost tier     | free        |

Reasoning: Fixing a typo is a simple text edit requiring minimal context.

Cost tiers:

- free: Local model (Ollama) — zero cost, good for trivial/simple tasks  <-- recommended
- cheap: Fast paid model (e.g. Haiku, GPT-4o Mini, Gemini Flash)
- moderate: Capable paid model (e.g. Sonnet, GPT-4o, Codex)
- expensive: Premium paid model (e.g. Opus, GPT-5, o1-pro)

---

### How to proceed

1. Switch agent — press `Tab` and select `local-worker`
2. Switch model — run `/models` and pick a free-tier model
3. Ignore — just keep working with your current setup if you disagree
```

### Acting on the recommendation

After getting a recommendation:

- **Switch agent**: Press `Tab` to cycle between agents. Select `local-worker` for free-tier tasks or stay on `build` for paid tiers.
- **Switch model**: Run `/models` to open the model picker and select a model matching the recommended tier.
- **Ignore**: Just continue with your current setup if you disagree with the recommendation.

Your choice is observed and logged to improve future recommendations.

### Using the tool directly

You can also ask the agent to call the tool without the slash command:

```
Use the route_task tool to analyze this task: refactor the authentication module
```

## How Learning Works

The plugin uses **implicit observation** to learn from your routing decisions:

1. When you run `/route`, the recommendation is stored in memory
2. When the session goes idle, the plugin logs the recommendation to `.opencode/router-history.jsonl`
3. On future `/route` calls, the last 20 history entries are injected as few-shot examples into the classifier prompt
4. Over time, the classifier adapts to your preferences

The history file is append-only JSONL. Each entry looks like:

```json
{"ts":"2026-03-16T10:30:00.000Z","prompt":"fix a typo in readme","recommendedTier":"free"}
```

## Configuration

### Changing the classifier model

Edit the constants at the top of `.opencode/plugins/task-router.ts`:

```typescript
const OLLAMA_BASE_URL = "http://localhost:11434"
const CLASSIFIER_MODEL = "qwen3:8b"
const MAX_HISTORY_EXAMPLES = 20
```

Alternative classifier models:
- `llama3.2:3b` -- faster, less reliable JSON output
- `qwen3:14b` -- better classification quality, more VRAM needed

### Customizing the local-worker agent

Edit `.opencode/agents/local-worker.md` to change the system prompt, model, or temperature:

```markdown
---
description: Lightweight agent for simple tasks
mode: primary
model: ollama/qwen3:8b
temperature: 0.2
---

Your custom system prompt here...
```

### Adding more Ollama models

Add models to `opencode.json` under the `ollama` provider:

```json
{
  "provider": {
    "ollama": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "Ollama (local)",
      "options": {
        "baseURL": "http://localhost:11434/v1"
      },
      "models": {
        "qwen3:8b": {
          "name": "Qwen3 8B (local/free)",
          "limit": { "context": 32768, "output": 8192 }
        },
        "llama3.2:3b": {
          "name": "Llama 3.2 3B (local/free)",
          "limit": { "context": 8192, "output": 4096 }
        }
      }
    }
  }
}
```

## File Structure

```
.opencode/
  plugins/
    task-router.ts          # Core plugin: route_task tool + event hooks + history
  commands/
    route.md                # /route slash command
  agents/
    local-worker.md         # Primary agent using Ollama for free-tier tasks
  package.json              # Plugin dependency (@opencode-ai/plugin)
  router-history.jsonl      # Auto-generated at runtime (gitignored)
opencode.json               # Ollama provider configuration
```

## Troubleshooting

### "Cannot connect to Ollama"

Make sure Ollama is running:

```bash
ollama serve
```

And that the classifier model is pulled:

```bash
ollama pull qwen3:8b
```

### "The requested model is not supported"

This usually means `ollama` is not in your `enabled_providers`. Add it to your global OpenCode config:

```jsonc
// ~/.config/opencode/opencode.jsonc
{
  "enabled_providers": ["your-provider", "ollama"]
}
```

### Classification returns wrong results

The classifier improves over time as it learns from your decisions. You can also:

- Switch to a larger classifier model (`qwen3:14b`)
- Clear the history file to reset learning: `rm .opencode/router-history.jsonl`

## License

MIT
