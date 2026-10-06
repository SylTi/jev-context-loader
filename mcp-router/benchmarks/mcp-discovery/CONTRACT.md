# Benchmark contract

This contract defines the [retrieval benchmark](README.md). Jev and BM25 select tools from a saved catalog; the experiment grades those selections without executing tools. Outputs stay in this benchmark directory.

The catalog is an immutable snapshot of 235 tools captured from a Codex session on 2026-10-06. Original descriptions and TypeScript input declarations are retained. Token counts use the `o200k_base` tokenizer on those complete textual definitions. These are neither estimated character counts nor counts from a Claude Fable tokenizer. The snapshot is not a raw MCP `tools/list` response.

Requests and acceptable required-tool groups are frozen before any Jev result is observed. They are author-created, not historical user requests. A group can contain alternative tools, any one of which satisfies that requirement. Empty groups mean no catalog tool should be used. Each case declares a development or held-out split and an English or French language.

BM25 and Jev receive identical tool names and descriptions, without schema text or ground-truth labels. The full instruction/schema token count is used only to measure what would enter the main model's context after selection. BM25 uses fixed k1=1.2, b=0.75 and Unicode word normalization. No language translation, synonyms, or relevance feedback is added to either method.

Compare native Jev >=0.75 selections and score-ranked selections at fixed 2000 and 5000 token budgets with BM25 under the same budgets. Never use evaluation labels to choose selections. Scores, catalog identity, request identity, and results are preserved on disk.

Recorded Jev measurements use the TypeSafe playground's browser UI. Credentials and browser session state are never exported. Only public tool definitions and synthetic benchmark requests are submitted. [PLAYGROUND.md](PLAYGROUND.md) describes how to repeat collection.

This is a retrieval study, not a native Claude/OpenAI tool-search benchmark or end-to-end task success evaluation. Browser timing includes UI overhead and is not API latency. API cost is unavailable unless the playground reports actual token usage.

The completed playground responses report token usage and server evaluation time. Preserve both separately from browser elapsed time. Any cost calculated from token usage and published API pricing is an API-equivalent estimate, not an asserted playground charge.
