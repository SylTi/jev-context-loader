# Discovery comparison

This benchmark compares built-in agent tool discovery with selection using Jev relevance scores. Tool schemas describe available operations and their parameters; loading fewer schemas can reduce the main model's context. Native means the runtime's built-in discovery workflow. Jev replay means using stored scores instead of making a live Jev request. The [proxy README](README.md) describes installation and benchmark commands.

These are separate experiments on a frozen 235-tool catalog and the same 14 diagnostic tasks, including two tasks requiring no tool. Costs include cache reads, output and reasoning, plus replay-based Jev estimates. They are API-equivalent estimates for subscription-backed runs, not billed charges. Jev inference is replayed, not freshly measured.

Success means the model made the expected calls to local tools returning synthetic data, used valid arguments, and included the returned facts and unique call receipts in its answer. Mean peak input is the average largest request context per task, in tokens, including cache reads. Costs are USD per task. Each arm is one runtime configuration.

| Runtime / model | Native success | Jev success | Native mean peak input | Jev mean peak input | Native cost/task | Jev cost/task |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Hermes v0.21.5 / glm-5.3-flash | 14/14 | 13/14 | 6058 | 2923 | $0.001122 | $0.002711 |
| OpenAI Codex / gpt-6.1-sol | 14/14 | 13/14 | 16060 | 8877 | $0.041231 | $0.025823 |

Hermes and OpenAI directly received the Jev-selected schemas. OpenCode used the MCP proxy with search, describe and call operations. These integration methods differ, so the rows are separate runtime comparisons. OpenAI showed a cost saving for Jev; Hermes showed a cost increase. The Jev configuration failed the Page-and-schedules task in both runtimes.

## Installed OpenCode V2 proxy comparison

| Arm | Success | Mean peak input | Model requests/task | Cost/task, one route | Cost/task, per uncached search |
| --- | ---: | ---: | ---: | ---: | ---: |
| native | 14/14 | 6568 | 6.79 | $0.002568 | $0.002568 |
| jev | 13/14 | 1774 | 3.93 | $0.002373 | $0.004057 |

The one-route estimate charges the original Jev fee once when any search occurs. The per-search estimate charges that frozen fee for each actual uncached ranking invocation. Identical cached queries are free. Rewritten queries receive the original task's scores in replay; live Jev might recover, fail differently or use a different number of searches.

Case h24 required reading a ChatGPT Page and its attached scheduled automations. The proxy tried 12 distinct searches and guessed schema IDs, then failed to retrieve either result. Both required tools scored below 0.75. The per-search estimate includes twelve ranking fees for this task. Case h21 used two ranking invocations; the other tool tasks used one each. Task definitions are in [cases.json](benchmarks/mcp-discovery/cases.json).

These are one run per task and arm, not a statistical reliability estimate. Usage covers retained assistant turns; hidden provider retries and auxiliary requests were not independently captured. Token field meanings were confirmed in the installed executable. Peak input includes uncached input and cached context.

Only matching case IDs are summarized. Startup/runtime errors are not successful completions and leave cost/context unknown. This prevents a failed native run from creating an apparent proxy saving. Exact events and fixture calls are in [results/opencode](results/opencode).

Three attempts with empty or incomplete catalogs are documented in [startup-attempts](results/opencode/startup-attempts/README.md) and excluded. Replacement runs waited for OpenCode plugin activation and catalog registration before starting inference. Their recorded assistant cost was $0.001023. These paired costs do not represent the total cost of all runner development or preflight attempts.

## Architecture and evidence

| Runtime | Discovery | Evidence |
| --- | --- | --- |
| [Hermes](https://hermes-agent.nousresearch.com/docs/user-guide/features/tool-search) | Bounded names/description listing; BM25 search, describe and call | Measured on GLM-5.3-Flash |
| [OpenAI](https://developers.openai.com/api/docs/guides/tools-tool-search) | Provider-native schema loading through namespaces/server summaries or client-executed retrieval | Measured through Codex dynamic namespaces, not a remote MCP transport |
| [Anthropic](https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-search-tool) | Provider-native BM25 or regex search with defer_loading; discovered tools become ordinary calls | Documentation only; completion and cost were not measured. |
| [OpenCode V2](https://opencode.ai/v2/docs/mcp-servers) | Code Mode execute; budgeted inline catalog and lexical search; per-tool permissions | Installed v0.0.0-beta-19059, 14 paired tasks with GLM-5.3-Flash; retained records and audit |
| [Jev MCP proxy](src/server.ts) | Jev scores whole upstream catalog; search, describe, generic call | Real MCP stdio demo and integration checks; live Jev API requires user key |

## What makes a separate proxy hard to justify

- Native discovery already avoids eager schema loading. The measured eager-to-native context reductions were 92.6% in the Hermes control and 87.1% across the OpenAI tasks.
- Ranking this frozen catalog used about 46.8K Jev input tokens, approximately $0.00197 per task at $0.042/M. That was larger than Hermes's entire native model cost per task.
- The 0.75 threshold hid both required tools in h24. An empty answer needs recovery; semantic scoring alone does not guarantee coverage.
- Search, describe and generic call add conversation steps. Native OpenCode also made discovery mistakes and extra requests in this run. Query caching only saves repeat identical searches, not rewritten queries.
- Generic dispatch hides individual upstream schemas and annotations from the provider tool list. This prototype validates input locally, but cannot reproduce the host's normal per-tool approvals.
- Live catalog metadata and queries go to another inference service. Interactive OAuth, resources, prompts, sampling and elicitation are additional integration work outside this prototype.

These findings do not prove semantic retrieval is universally useless. Larger catalogs with opaque names and difficult queries remain a possible use case. The data does not support a blanket claim that Jev always costs more.

## Reproduce the report

From the repository root, run the following commands. They read saved results and make no live model requests. To collect new completion results, follow the [OpenCode](README.md#compare-installed-opencode-v2), [Codex](benchmarks/mcp-discovery/codex/README.md#rerun) or [Hermes](benchmarks/mcp-discovery/hermes/README.md#rerun) instructions.

```sh
npm --prefix mcp-router ci --ignore-scripts
npm --prefix mcp-router run compare
```

Pricing sources: [GLM-5.3-Flash](https://docs.z.ai/guides/overview/pricing), [GPT-6.1-Sol](https://developers.openai.com/api/docs/models/gpt-6.1-sol), [Jev](https://docs.typesafe.ai/models). Rates captured on 2026-10-06. Anthropic cost was not measured.
