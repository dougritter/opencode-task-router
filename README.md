# OpenCode Task Router

An [OpenCode](https://opencode.ai) plugin that classifies a development task with a local Ollama model and recommends the right cost tier and agent to use.

It is designed to keep simple work on free local models and reserve paid models for tasks that actually need them.

## What You Get

- A `route_task` tool for task-to-model routing recommendations
- Cost-tier recommendations: `free`, `cheap`, `moderate`, `expensive`
- Agent guidance based on the recommended tier
- Lightweight learning from your past routing decisions

## Prerequisites

1. [OpenCode](https://opencode.ai) installed
2. [Ollama](https://ollama.ai) installed and running
3. The classifier model pulled locally:

```bash
ollama serve
ollama pull qwen3:8b
```

If your global OpenCode config uses `enabled_providers`, include `ollama` there too:

```jsonc
{
  "enabled_providers": ["github-copilot", "ollama"]
}
```

## Install From NPM

Add the plugin package to your OpenCode config:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-task-router"]
}
```

Then restart OpenCode. OpenCode installs npm plugins automatically with Bun at startup.

## Minimal Usage

Ask OpenCode to call the tool directly:

```text
Use the route_task tool to analyze this task: refactor the authentication module
```

Typical output:

```text
## Task Routing Recommendation

| Factor | Assessment |
|--------|-----------|
| Complexity | **moderate** |
| Context needs | **medium** |
| Cost tier | **moderate** |

**Reasoning:** Multi-file refactoring usually needs broader codebase context.
```

## Optional Full Setup

The npm package guarantees the `route_task` tool.

If you also want the `/route` shortcut, a local free-tier agent, and an example Ollama provider config, copy the example files from `examples/opencode/` into your project:

```text
examples/opencode/
├── opencode.json
└── .opencode/
    ├── agents/
    │   └── local-worker.md
    └── commands/
        └── route.md
```

Suggested mapping:

- `examples/opencode/.opencode/commands/route.md` -> `.opencode/commands/route.md`
- `examples/opencode/.opencode/agents/local-worker.md` -> `.opencode/agents/local-worker.md`
- `examples/opencode/opencode.json` -> merge into your project `opencode.json`

## How It Works

1. `route_task` sends your task description to a local Ollama classifier
2. The classifier returns task complexity, context estimate, and cost tier
3. The plugin recommends an agent and model tier
4. When the session goes idle, the plugin logs what was recommended to `.opencode/router-history.jsonl`
5. Recent history is reused as calibration on future routing decisions

## Configuration

The plugin currently defaults to:

```ts
const OLLAMA_BASE_URL = "http://localhost:11434"
const CLASSIFIER_MODEL = "qwen3:8b"
const MAX_HISTORY_EXAMPLES = 20
```

These live in `src/index.ts`.

## Local Development

Install dependencies and build the package:

```bash
npm install
npm run build
npm test
```

For local OpenCode development in this repo, the project plugin entrypoint at `.opencode/plugins/task-router.ts` re-exports the package source from `src/index.ts`.

The smoke test automates what is practical without depending on a real OpenCode session:

- builds the package
- creates a tarball
- installs the tarball into a temporary directory
- imports the installed package
- executes `route_task` with a mocked Ollama response
- verifies the history file is written

The unit tests cover the internal routing logic directly:

- cost-tier inference from provider/model ids
- classifier response parsing and normalization
- prompt construction with calibration history
- history file read/write helpers
- plugin recommendation, retry, and idle logging behavior

## CI And Publishing

This repo includes GitHub Actions for:

- CI on pushes to `main` and pull requests
- npm publishing from version tags like `v0.1.0`
- manual publish dry runs through `workflow_dispatch`

Publishing can be fully automated through GitHub Actions using npm trusted publishing with GitHub OIDC.

See `RELEASE.md` for the release checklist and tag-based publishing flow.

## Troubleshooting

### Cannot connect to Ollama

Make sure Ollama is running and the model is installed:

```bash
ollama serve
ollama pull qwen3:8b
```

### Plugin loads but routing falls back to moderate

That usually means the classifier returned invalid output. The plugin retries once, then falls back to a safe default.

### No history file created yet

The history file is only written after a routing recommendation and when the session goes idle.

## License

MIT
