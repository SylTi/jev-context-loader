# jev-context-loader

An experiment in reducing AI agent context by loading skills and MCP tool definitions on demand. Results are mixed and do not establish a general advantage over existing discovery mechanisms. Saving context is the primary goal; lower cost is a possible secondary benefit.

## What this project tests

AI agents need descriptions of the capabilities they can use. A **skill** is a reusable set of instructions, usually stored in a `SKILL.md` file. **MCP**, the Model Context Protocol, lets an agent application connect to external tools. Each tool has a name, description and parameter schema.

Loading every skill description or tool schema takes up space in the model's context. This project tests whether [Jev](https://docs.typesafe.ai/models), a TypeSafe model used to score relevance, can select the capabilities needed for a task before their full instructions or definitions reach the main model. Both routers disclose matches scoring at least 0.75.

| Component | Approach | Documentation |
| --- | --- | --- |
| `skills-router/` | Advertises one router skill with a catalog summary, then loads relevant skills from a local catalog. | [Setup, behavior and estimates](skills-router/README.md) |
| `mcp-router/` | Connects to MCP servers and exposes three operations: search for tools, load their schemas, and invoke them. | [Proxy setup and reproduction](mcp-router/README.md), [benchmark comparison](mcp-router/COMPARISON.md) |

The command names are `jev-skills-router` and `jev-mcp-router`. Each component has its own package, source and tests. MCP benchmark code, input catalogs and result data are in [mcp-router/benchmarks/mcp-discovery](mcp-router/benchmarks/mcp-discovery/README.md).

## Skills routing results: estimates only

Ordinary skill discovery includes each skill's name and description in the agent's prompt. The router replaces that list with a single skill and a generated capability summary.

The estimates below use 78 tokens per catalog entry and 550 tokens for the router. The catalog average comes from a sample of installed skills. Token counts are approximated as characters divided by four.

| Skills | Ordinary catalog tokens | Router tokens | Estimated tokens saved per model request |
| ---: | ---: | ---: | ---: |
| 5 | 390 | 550 | -160 |
| 10 | 780 | 550 | 230 |
| 20 | 1,560 | 550 | 1,010 |
| 50 | 3,900 | 550 | 3,350 |
| 100 | 7,800 | 550 | 7,250 |

A pricing calculation using Claude Fable 5.1 estimates $0.08996 saved on initial discovery for a task with 100 skills. Across 100 tasks with 100 model requests each, including cache reads, the estimate is $26.94. These are calculations, not measured task bills.

The calculation excludes extra routing messages, initial classification, setup, cache misses and changes in model behavior. Skill routing has not been evaluated in a live task-completion benchmark. Its actual accuracy and effect on task performance remain unmeasured. See the [assumptions, rates and cost tables](skills-router/README.md#context-savings-and-cost-estimates).

## MCP routing results: model runs with stored Jev scores

Three agent runtimes were evaluated on a fixed catalog of 235 tools and 14 diagnostic tasks, including two requiring no tool. Agents used real model inference to execute local tools returning synthetic data. A successful task required the expected tool calls, valid arguments and the returned facts and unique call receipts in the answer. Receipts identify fixture executions so that the grader can check whether an answer used the tool results.

**Native** means the runtime's built-in discovery workflow. **Jev replay** means selection using relevance scores previously collected in the TypeSafe playground, without making a new Jev request during execution. Replay makes the comparison reproducible but does not test how live Jev would respond to rewritten searches.

| Runtime / model | Task success, native → Jev | Mean peak input tokens, native → Jev | Estimated cost/task, native → Jev |
| --- | ---: | ---: | ---: |
| Hermes / GLM-5.3-Flash | 14/14 → 13/14 | 6,058 → 2,923 | $0.001122 → $0.002711 |
| OpenAI Codex / GPT-6.1-Sol | 14/14 → 13/14 | 16,060 → 8,877 | $0.041231 → $0.025823 |
| OpenCode V2 / GLM-5.3-Flash | 14/14 → 13/14 | 6,568 → 1,774 | $0.002568 → $0.004057 |

Hermes and Codex received the selected tool schemas directly. OpenCode used the MCP proxy. Different runtime prompts and integration methods mean these are separate comparisons, not a ranking of models.

Peak input measures context occupancy, including cached input. Costs include cache reads, output and reasoning, plus estimated Jev fees. The model runs used subscriptions, so these are estimates at API prices rather than billed charges.

OpenCode's proxy reduced mean peak input by 73%. With one ranking fee per task, its estimated cost would be $0.002373, about 8% below native. Charging every uncached search raises that estimate to $0.004057, about 58% above native. One failed task triggered 12 distinct searches. Each rewritten query received the same stored task-level scores; live Jev could return different selections and require fewer or more searches.

A separate retrieval test found all required tools for 33/34 held-out tasks with Jev, versus 24/34 for basic keyword search using BM25 and a 2,000-token budget. Retrieval accuracy alone does not measure whether an agent can complete the task.

All three Jev completion comparisons failed the task of reading a ChatGPT Page and its attached scheduled automations. The required tools scored below 0.75 and were omitted. Native discovery completed that task. Anthropic's discovery implementation is covered through documentation, with no completion or cost measurements.

These results come from one run per task and configuration. The task subset includes a failure already identified by the retrieval test and is not a random workload sample. Three OpenCode attempts with incomplete catalogs at startup are recorded separately and excluded from the comparison. Hidden provider retries and auxiliary OpenCode requests were not independently measured. See the [methods, results and limitations](mcp-router/COMPARISON.md).

## Run the experiments

Requires Node.js 22 or newer and npm. From the repository root:

```sh
npm --prefix skills-router ci
npm --prefix skills-router run build
npm --prefix skills-router test

npm --prefix mcp-router ci --ignore-scripts
npm --prefix mcp-router test
npm --prefix mcp-router run demo
npm --prefix mcp-router run compare
npm --prefix mcp-router run audit
```

The MCP demo uses local synthetic tools and stored scores. The comparison and audit commands read saved results. These commands require no Jev key and make no live model requests.

Live routing requires a TypeSafe API key. Repeating the model benchmarks requires an authenticated agent runtime and consumes its provider usage. Installation and benchmark instructions are in the component READMEs.

Checks have been run on Linux. GitHub Actions also defines Windows, macOS and WSL 2 jobs; those platforms have not been verified locally.
