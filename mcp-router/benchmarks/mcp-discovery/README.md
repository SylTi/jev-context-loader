# MCP discovery benchmark

This retrieval experiment compares [Jev](https://docs.typesafe.ai/models), a model
that scores relevance, with BM25, a keyword-based ranking algorithm. Both select
from the same saved tool catalog. MCP, the Model Context Protocol, connects agent
applications to tools; this catalog also contains application-native functions.
The experiment measures selection of required tools, without executing them.

Jev substantially outperformed this fixed BM25 baseline on a small synthetic retrieval benchmark. At a 0.75 threshold, it retrieved every required tool for 33 of 34 held-out tasks while selecting about 601 tokens of definitions per request. This is evidence that Jev can route MCP tools efficiently. It does not yet justify building a separate proxy over native tool search.

All 50 tasks ran in the authenticated TypeSafe playground on 2026-10-06 using `jev-1.13.0`. The benchmark stores its artifacts in this directory and does not execute catalog tools or access their connected services.

## Inputs and method

- 235 real definitions captured from one Codex session across Codex, Linear, GitHub, and ChatGPT Spaces. Original descriptions and TypeScript parameter declarations are preserved in [raw-tools.json](raw-tools.json).
- 50 author-created synthetic tasks, with labels frozen before Jev runs: 10 development tasks and 40 held-out tasks. The held-out set contains 34 tasks requiring tools and 6 no-tool tasks. Twelve are French, ten of which require tools.
- Full catalog footprint: **67,719 tokens** using `o200k_base` on complete textual definitions. This is a hypothetical full-preload reference, not a measured native Codex prompt, a raw MCP `tools/list` response, or an exact Fable tokenizer count.
- BM25 and Jev receive identical names and descriptions, without parameter schemas or labels. Selected definitions are charged against budgets using their complete token counts. Labels accept specified alternative tools.
- BM25 uses fixed k1=1.2 and b=0.75, with Unicode word normalization and no stemming, synonyms, translation, stop-word removal, or tuned abstention gate. Jev scores each of the 235 tools independently in one request per task.
- Jev's threshold was fixed at >=0.75. No prompts, labels, or thresholds were tuned after seeing held-out results.

See [CONTRACT.md](CONTRACT.md) and [manifest.json](manifest.json) for the contract, frozen hashes, and parameters. Retrieval does not measure whether the main model can correctly execute the selected tools.

## Held-out results

| Method | Mean required-tool recall | Tasks with all requirements | Correct no-tool abstentions | Mean selected definition tokens | Mean selected tools |
| --- | ---: | ---: | ---: | ---: | ---: |
| BM25, 2,000-token budget | 73.0% | 24/34 | 0/6 | 1,964 | 8.10 |
| BM25, 5,000-token budget | 83.3% | 27/34 | 0/6 | 4,961 | 17.25 |
| Jev, >=0.75 threshold | **97.1%** | **33/34** | **6/6** | **601** | **2.00** |
| Jev ranking, 2,000-token budget | 98.5% | 33/34 | 0/6 | 1,965 | 8.43 |
| Jev ranking, 5,000-token budget | 100% | 34/34 | 0/6 | 4,964 | 19.13 |

Budget-only methods greedily fill the budget using positive scores and skip definitions too large to fit. They do not apply Jev's 0.75 threshold. Consequently, neither budget-only method reliably abstains on no-tool tasks. The threshold row is a separate policy, with no fixed token cap. Its largest held-out selection was 4,400 tokens.

Required-tool recall averages each positive task's fraction of requirement groups retrieved. A complete task has all groups represented. Extra tools do not reduce recall, so recall alone does not establish selection precision or execution safety.

| Language, positive held-out tasks | BM25, 2,000 tokens | BM25, 5,000 tokens | Jev, >=0.75 |
| --- | ---: | ---: | ---: |
| English, 24 tasks | 82.6% | 91.0% | 95.8% |
| French, 10 tasks | 50.0% | 65.0% | 100% |

The French results are encouraging for English tool descriptions, but ten positive tasks are too few to establish general multilingual reliability. Many tasks name a provider explicitly, making service identification easier.

## Context impact

The threshold policy selected 601 definition tokens on average across all 40 held-out tasks, including six with no tools. Compared with the 67,719-token full-preload reference, that avoids approximately **67,118 tokens, or 99.1%**. Among positive tasks alone, the mean was 707 tokens.

This comparison excludes discovery-tool schemas, server summaries, extra conversation messages, tool outputs, reasoning, and subsequent task steps. Native just-in-time discovery also avoids full preloading. The 99.1% figure is therefore not an improvement over native Claude or OpenAI discovery.

## Failures and excess selections

At the fixed threshold, case `h24` failed completely. It asked to read a ChatGPT Page and its attached schedules. Jev scored `spaces.read_page` at 0.68 and `spaces.list_page_automations` at 0.70, selecting neither. A router that treats an empty selection as proof that no tools are needed would mishandle this task. The 5,000-token ranking policy retrieved both, but also adds unrelated definitions and loses no-tool abstention.

The threshold policy selected 0.9 non-labelled tools per held-out request on average. Some may be useful prerequisites or alternative implementations omitted from the labels, so this is not a definitive false-positive count. There are also clear over-selections. For the read-only sharing-permissions case `h16`, Jev selected `spaces.update_page_sharing` at 0.86 and `spaces.update_space_sharing` at 0.81. Exposing a tool is not authorization to execute it; the calling model must still respect the user's request.

## Latency and API-equivalent cost

The playground reported actual token usage and server evaluation time for every request. Across the 50 scored requests:

| Measurement | Result |
| --- | ---: |
| Jev input tokens | 2,339,351 |
| Jev output tokens | 217,950 |
| Server evaluation p50 / p95 | 278 ms / 369 ms |
| Browser workflow p50 / p95 | 2.07 s / 2.57 s |
| API-equivalent total cost | $0.0983 |
| API-equivalent cost per request | $0.00197 |

Percentiles use nearest rank. The browser measurement includes automation and UI overhead. The first run also includes time between tool calls. Server evaluation time excludes network and UI overhead and is not a measured direct API round trip.

The cost estimate multiplies reported input tokens by Jev 1.13's published **$0.042 per million input tokens**, with free output. Pricing was checked on 2026-10-06 in the [TypeSafe model documentation](https://docs.typesafe.ai/models). This is an API-equivalent estimate, not an assertion that the playground charged this amount. The separate pilot is excluded. It does not include main-model costs or integration overhead.

## What this supports

Jev deserves consideration as a semantic retrieval engine, particularly for multilingual queries and explicit no-tool decisions. At the same 2,000-token definition budget, its ranking reached 98.5% required-tool recall compared with BM25's 73.0%.

A separate MCP proxy remains unproven by retrieval alone. [Claude's tool search](https://www.anthropic.com/engineering/advanced-tool-use) and [OpenAI's tool search](https://developers.openai.com/api/docs/guides/tools-tool-search) already offer deferred discovery, which loads tool definitions when needed. This retrieval-only study did not run either implementation. The [Codex completion comparison](codex/README.md) compares native OpenAI discovery with eager loading and replayed Jev selections using synthetic local tools. The [MCP proxy and OpenCode comparison](../../README.md) tests a proxy using the same saved scores. Claude discovery remains untested.

The [Hermes comparison with GLM-5.3-Flash](hermes/README.md) uses an installed
Hermes runtime and the same synthetic local tools, tasks and completion grader. It tests
Hermes's default discovery against the replayed Jev selections. Its scripts,
runtime source snapshots, transcripts and usage records are retained separately.

## Artifacts and verification

- `results/jev-raw-responses.json`: 50 complete responses copied from the playground's visible JSON output, including usage, evaluation time, model version, and distinct request IDs.
- `results/jev-runs.json`: 11,750 tool scores in catalog order.
- `results/ui-inputs.json`: submitted task texts and the pasted question hash.
- `results/report.json`: metrics, runtime totals, and all per-case selections.
- `results/rows.csv`: per-case comparison table.
- `results/playground-completed.jpg`: final playground response evidence.

The artifact audit verified that all 50 submitted task IDs and texts exactly match the frozen cases, the pasted questions hash matches the prepared file, all 11,750 scores are valid and match their raw responses, usage and models align, and all 50 request IDs are distinct.

Requires Node 22. From this directory:

```sh
npm install --ignore-scripts
npm run typecheck
npm test
npm run report
```

`prepare` can regenerate catalog and payload artifacts from source files. Preserve the frozen inputs and results when reproducing this run. Typecheck and the three helper tests passed on Linux with Node 22.23.3. The [Codex benchmark](codex/README.md) measures task completion using local tools returning synthetic data. [Playground rerun instructions](PLAYGROUND.md) describe manual collection and the browser helper used for the recorded measurements.
