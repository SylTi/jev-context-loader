# MCP discovery across agent runtimes

Research snapshot: 2026-10-06. OpenDots refers to [CopilotKit/OpenDots](https://github.com/CopilotKit/OpenDots).

This report examines how Hermes, OpenClaw, OpenCode and OpenDots expose tools to their language models, including GLM and MiMo. Tool discovery loads relevant tool descriptions and parameter schemas on demand instead of placing the entire catalog in the model's initial context. The question is whether Jev, a model that scores relevance, adds value to those existing discovery workflows.

Findings below come from public documentation and selected upstream source at the stated date. They are not a new evaluation of installed releases or model quality. Linked completion benchmarks provide separate experimental evidence.

The [Hermes benchmark](../hermes/README.md) tested installed
Hermes v0.21.5 with GLM-5.3-Flash and synthetic tools. Native discovery completed
14/14 tasks versus 13/14 for replayed Jev selections. GLM used the compact tool
listing and `tool_describe` directly, without invoking BM25 search.

## Findings

A reusable semantic retrieval component is worth investigating. A separate context-saving proxy has a weaker case because Hermes, OpenClaw, and OpenCode V2 already provide progressive tool discovery. Jev would need to improve retrieval, completion, latency, or total cost over those implementations.

For a business-agent application, a useful component would be a catalog containing only tools authorized for the current agent, with interchangeable retrieval backends. Jev could be one backend. Skill installation and migration solve a separate problem. [The business-agent example below](#application-to-business-agent-products) discusses this boundary using Limova's publicly described integrations.

## What the runtimes do

| Runtime | Initial exposure and discovery | Likely value of Jev |
| --- | --- | --- |
| Hermes Agent, reviewed upstream | Core working tools stay direct. Deferred tools use a bounded capability listing and ordinary `tool_search`, `tool_describe`, and `tool_call` functions. Retrieval uses BM25. | Little reason to duplicate its discovery infrastructure. A semantic retrieval backend could improve difficult queries. |
| OpenClaw, reviewed upstream | Structured search is enabled by default for embedded and Copilot runs. It uses a bounded capability directory and search/describe/call controls over the policy-filtered catalog. Retrieval uses BM25 with English normalization. | Same opportunity: retrieval quality rather than introducing deferred discovery. |
| OpenCode V1, normal path | Connected MCP definitions become ordinary tools. Permissions filter them, then the request includes the remaining tools. V1 also has an experimental Code Mode path. | Context savings can be substantial when using the ordinary eager path. Code Mode is an existing alternative. |
| OpenCode V2, documented behavior | Code Mode is the default for MCP servers. A JavaScript `execute` tool dispatches catalog tools. The shared Code Mode runtime provides a budgeted inline catalog and search for omitted entries. | A separate proxy overlaps its existing discovery. Improving its lexical search is more interesting. |
| CopilotKit/OpenDots | The reviewed template uses TanStack AI with an OpenAI-compatible Chat Completions adapter. It passes its selected server/client tools directly to `chat`. It has separate progressive loading for learned skills. | Limited immediate context benefit for the reviewed tool set. A discovery layer becomes more useful when many business integrations are added. |

These findings describe the reviewed source and documentation, not every installed release or configuration. OpenCode V1 and V2 must be distinguished when assessing an actual installation. BM25 is a keyword-based ranking algorithm. Search/describe/call functions let the model search a catalog, retrieve a tool's schema, then invoke it through a dispatcher.

## Hermes

The source sets `tools.tool_search.enabled` to `auto`, which acts like `on` in the reviewed version when a deferred tool exists. Its listing budget is the smaller of 5% of model context and 4,000 estimated tokens. The manifest degrades from short descriptions to names and server summaries as necessary. Search returns five matches by default and accepts up to 25 per query. These settings keep the full schemas outside the initial request.

Sources: [configuration defaults](https://github.com/NousResearch/hermes-agent/blob/0dbaf33f67acf1f6d8e8e6c6efe8042ef8db98c4/hermes_cli/config_defaults.py#L1991), [bridge implementation](https://github.com/NousResearch/hermes-agent/blob/0dbaf33f67acf1f6d8e8e6c6efe8042ef8db98c4/tools/tool_search.py), [user documentation](https://hermes-agent.nousresearch.com/docs/user-guide/features/tool-search).

BM25 indexes the split tool name, source label, description, and top-level parameter names. It uses English stemming and relevance rules, including exact-name handling. The main model generates search queries and can describe a known tool without searching. No separate inference service is needed for retrieval. The generic call resolves through the agent application's tool registry and retains execution controls.

Source: [catalog and retrieval implementation](https://github.com/NousResearch/hermes-agent/blob/0dbaf33f67acf1f6d8e8e6c6efe8042ef8db98c4/tools/tool_search_catalog.py).

Hermes also supplies its own real-model A/B test scripts for discovery on/off, with scenario transcripts and call checks. The documented runner uses Claude Haiku 4.5 through OpenRouter. That does not establish GLM/MiMo performance, but provides an integration starting point.

Source: [Hermes discovery evaluation](https://github.com/NousResearch/hermes-agent/blob/0dbaf33f67acf1f6d8e8e6c6efe8042ef8db98c4/evals/tool_search/README.md).

## OpenClaw

The reviewed configuration resolver enables structured Tool Search when the setting is absent. `tools.toolSearch: false` restores direct exposure. The usual search limit is eight, with a maximum of 20. Code Mode can take precedence; Codex-backed runs use their own native discovery.

Sources: [configuration implementation](https://github.com/openclaw/openclaw/blob/2e59936b6747f10c44edb76decd662c2d27305be/src/agents/tool-search-config.ts), [Tool Search documentation](https://docs.openclaw.ai/tools/tool-search).

The directory is bounded at 18,000 characters and keeps a stable rendering while the authorized catalog remains unchanged. The model can retrieve metadata, then call by catalog ID. MCP calls retain their owning execution boundary. English queries are explicitly requested. Its ranking includes lexical normalization and intent expansion; MCP/client tools are searched by name and description, without indexing their untrusted parameter schemas.

Sources: [directory implementation](https://github.com/openclaw/openclaw/blob/2e59936b6747f10c44edb76decd662c2d27305be/src/agents/tool-search-directory.ts), [ranking implementation](https://github.com/openclaw/openclaw/blob/2e59936b6747f10c44edb76decd662c2d27305be/src/agents/tool-search-ranking.ts), [reviewed upstream documentation](https://github.com/openclaw/openclaw/blob/2e59936b6747f10c44edb76decd662c2d27305be/docs/tools/tool-search.md).

Consequently, French user input does not imply raw French BM25 input. The model is instructed to produce an English search query. This distinction matters when comparing the French retrieval results in this repository with OpenClaw.

## OpenCode

V1's MCP service enumerates the cached definitions of connected servers. Session tool construction converts each definition to a model tool with its schema. Request preparation removes disabled tools; the default AI SDK path sets `activeTools` to the remaining keys and supplies the complete tool map. Its public V1 documentation warns about MCP context overhead.

Sources: [MCP service](https://github.com/anomalyco/opencode/blob/3f393d78bfc3f0826b2c7080e57964c235704695/packages/opencode/src/mcp/index.ts#L666), [session tool construction](https://github.com/anomalyco/opencode/blob/3f393d78bfc3f0826b2c7080e57964c235704695/packages/opencode/src/session/tools.ts#L390), [request preparation](https://github.com/anomalyco/opencode/blob/3f393d78bfc3f0826b2c7080e57964c235704695/packages/opencode/src/session/llm/request.ts#L210), [model request](https://github.com/anomalyco/opencode/blob/3f393d78bfc3f0826b2c7080e57964c235704695/packages/opencode/src/session/llm.ts#L317), [V1 MCP docs](https://opencode.ai/docs/mcp-servers/).

V1 has `OPENCODE_EXPERIMENTAL_CODE_MODE`. Its adapter supplies MCP tools through an `execute` function rather than individual provider tools. V2's official MCP documentation says Code Mode is the default and a server can opt out with `codemode: false`. This section describes documented V2 behavior. The separate [OpenCode V2 benchmark](../../../COMPARISON.md#installed-opencode-v2-proxy-comparison) evaluates an installed binary with GLM-5.3-Flash.

Sources: [V1 runtime flag](https://github.com/anomalyco/opencode/blob/3f393d78bfc3f0826b2c7080e57964c235704695/packages/opencode/src/effect/runtime-flags.ts#L48), [V1 Code Mode adapter](https://github.com/anomalyco/opencode/blob/3f393d78bfc3f0826b2c7080e57964c235704695/packages/opencode/src/tool/code-mode.ts), [V2 MCP docs](https://opencode.ai/v2/docs/mcp-servers), [V2 tools docs](https://opencode.ai/v2/docs/tools/).

The shared Code Mode implementation budgets full inline catalog entries to 2,000 estimated tokens by default. Namespace summaries and fixed instructions are additional. The model can call `tools.$codemode.search` inside `execute` to obtain exact callable signatures for omitted tools. Search is deterministic weighted substring matching over paths, descriptions, and searchable schema text, with camel-case splitting and simple plural variants. It is not BM25. Execution preserves per-tool permissions.

Sources: [Code Mode API](https://github.com/anomalyco/opencode/blob/3f393d78bfc3f0826b2c7080e57964c235704695/packages/codemode/src/codemode.ts), [catalog budgeting and retrieval](https://github.com/anomalyco/opencode/blob/3f393d78bfc3f0826b2c7080e57964c235704695/packages/codemode/src/tool-runtime.ts), [Code Mode guide](https://github.com/anomalyco/opencode/blob/dev/packages/codemode/README.md).

A provider-native Anthropic search-result round-trip PR, #48466, was still open and unmerged during this review. It should not be confused with generic Code Mode. Community search forks/plugins also exist, including [opencode-tool-search-tool](https://github.com/famitzsy8/opencode-tool-search-tool) and [openstellar-tool-search](https://github.com/open-stl/openstellar-tool-search). Their existence alone does not prove upstream integration or compatibility with a particular installed version.

Source: [PR #48466](https://github.com/anomalyco/opencode/pull/48466).

## CopilotKit/OpenDots

The reviewed `DotAgent` builds a tool list from research, page, computer, client review, and learned-skill tools. It feeds that list directly into TanStack `chat` through `openaiCompatibleText`, using the Chat Completions protocol. Intelligence persists threads; it is not evidence of a separate MCP retrieval service. The inspected template does not wrap Hermes/OpenClaw/OpenCode or supply their discovery automatically.

Source: [DotAgent model invocation](https://github.com/CopilotKit/OpenDots/blob/565bf781d654339ee1ce83b17ee00d76d679608e/src/server/dot-agent.ts#L279).

Learned-skill delivery inserts a skill catalog into system prompts and exposes `copilotkit_load_skill` and `copilotkit_read_skill_file`. That progressively loads instruction bodies, while tool exposure follows the separate path above. Per-Dot permissions already narrow available capabilities.

Sources: [learned-skill tools](https://github.com/CopilotKit/OpenDots/blob/565bf781d654339ee1ce83b17ee00d76d679608e/src/server/tanstack-tools.ts), [setup and skill delivery](https://github.com/CopilotKit/OpenDots/blob/565bf781d654339ee1ce83b17ee00d76d679608e/docs/SETUP.md).

OpenDots provides an example of agent and UI integration. Its reviewed tool set is small and does not establish a need for a separate router. Adding many external integrations would change that calculation.

## GLM and MiMo

Ordinary function calling is enough for search/describe/call or an `execute` dispatcher. The agent application stores the large catalog; the model API only receives the dispatcher definitions and subsequently disclosed information. Native provider flags such as `defer_loading` are unnecessary for this architecture.

Z.ai's reviewed Chat Completions reference documents a maximum of 128 functions. Deployment behavior can differ: the [Hermes eager control](../hermes/README.md) sent 235 distinct function definitions to the Coding Plan endpoint, which accepted them. The retained SDK request events verify the outgoing count. GLM-5.3 documents a 1M-token context window and supports function calling and caching.

Sources: [Z.ai Chat Completions tools contract](https://docs.z.ai/api-reference/llm/chat-completion), [GLM-5.3](https://docs.z.ai/guides/llm/glm-5.3).

The reviewed MiMo documentation describes both Chat Completions and Responses endpoints, including function calling. Responses compatibility alone does not prove support for every OpenAI tool type. The reviewed MiMo reference does not document native tool-search/deferred-loading controls, and warns that undocumented parameters may be ignored or cause errors. Its reasoning history must also be preserved as required by the chosen protocol. A new wire proxy should not assume full provider compatibility.

Sources: [MiMo Chat Completions](https://mimo.mi.com/docs/en-US/api/chat/openai-api), [MiMo Responses compatibility and limitations](https://mimo.mi.com/docs/en-US/api/chat/responses).

The reviewed OpenClaw MiMo integration lists 1,048,576-token context windows for the V2.6 models. Smaller exposed catalogs can still improve planning and avoid tool-count limits, but context capacity by itself is a weak justification at that scale.

Source: [OpenClaw MiMo model catalog](https://docs.openclaw.ai/providers/xiaomi).

Cheap cached input reduces the financial case for a paid semantic router. The following is a price illustration, not a new benchmark. It assumes exactly 50,000 input tokens can be removed from one request, without changing output or adding model turns.

| Model | Uncached input / million | Cached input / million | Value of removing 50K uncached tokens | Value of removing 50K cached tokens |
| --- | ---: | ---: | ---: | ---: |
| GLM-5.3 | $1.40 | $0.26 | $0.0700 | $0.0130 |
| GLM-5.3-Flash | $0.15 | $0.03 | $0.0075 | $0.0015 |
| MiMo-V2.6-Pro | $0.435 | $0.0036 | $0.02175 | $0.00018 |
| MiMo-V2.6-Flash | $0.14 | $0.0028 | $0.0070 | $0.00014 |

Sources: [Z.ai pricing](https://docs.z.ai/guides/overview/pricing), [MiMo international real-time pricing](https://mimo.mi.com/docs/en-US/price/pay-as-you-go). Reviewed 2026-10-06. Subscription/token-plan economics and batch pricing differ. Cached input still occupies model context.

The [retrieval benchmark](../README.md#latency-and-api-equivalent-cost) recorded about $0.00197 of API-equivalent Jev routing cost per request. On a warm MiMo request, removing even 50K cached tokens would not repay that routing fee by input savings alone. Reduced errors or fewer subsequent model turns could change the result. Reusing one routing result across multiple requests also changes it. These are hypotheses to measure, not observed savings for these models.

## Retrieval and completion evidence

At the same 2,000-token selected-definition budget, Jev ranking achieved 98.5% mean required-tool recall versus 73.0% for the fixed BM25 baseline in this repository. This is a fairer ranking comparison than contrasting thresholded Jev abstention with an unthresholded BM25 policy. The thresholded Jev policy achieved 97.1%, with every requirement retrieved for 33 of 34 positive held-out tasks, and selected 601 definition tokens on average across all held-out tasks.

The baseline used raw task text, no stemming, translation, or query rewriting. Native agent applications let the main model formulate queries, observe matches, and retry. Hermes and OpenClaw also use different indexing and ranking. OpenCode Code Mode uses a different lexical algorithm altogether. The result establishes that Jev beat this fixed baseline. It does not establish superiority over native discovery workflows.

The [Codex fixture benchmark](../codex/README.md) recorded 14/14 completions for native discovery and 13/14 for replayed Jev selections. Jev's fixed threshold missed the Page/schedule case. This is why an empty Jev selection should not become an irreversible declaration that no capability exists.

The retrieval and Codex experiments do not establish GLM/MiMo completion quality. The [Hermes comparison](../hermes/README.md) and [OpenCode V2 proxy comparison](../../../COMPARISON.md) supply GLM-5.3-Flash completion evidence for this catalog. MiMo remains untested.

## Why native lab discovery is not simply the opposite of lexical search

Anthropic explicitly supplies regex and BM25 tool-search variants. Claude constructs the query, the search retrieves references, and the API expands discovered definitions into context. The API preserves the system-prompt prefix. Anthropic also permits custom retrieval strategies, including embeddings.

Sources: [Claude tool-search contract](https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-search-tool), [Anthropic advanced tool use](https://www.anthropic.com/engineering/advanced-tool-use).

OpenAI's hosted approach exposes namespace/server summaries to the model. Its example loads the `crm` path. The documentation says models were primarily trained to search namespaces/servers, recommends small groups, and supports client-executed discovery with application-defined lookup. Discovered tools enter the end of context for cache reuse. The documentation reviewed does not establish the internal ranking algorithm of hosted search.

Source: [official OpenAI tool-search documentation](https://developers.openai.com/api/docs/guides/tools-tool-search).

There are two separate decisions: when/what the main model wants to discover, and how the system retrieves candidates. Hermes and OpenClaw also leave the first decision to the model. Native provider integration and semantic retrieval are independent choices; Jev could implement client-side retrieval behind a native discovery interface.

The mechanisms have different engineering tradeoffs:

| Choice | Benefit | Cost or weakness |
| --- | --- | --- |
| Main model chooses a visible namespace | Uses conversation reasoning and explicit group descriptions; no keyword match needed to choose that group | Summary coverage/grouping matters; loading a broad group can expose unnecessary definitions |
| Main model queries local lexical search | Cheap, fast, inspectable retrieval; no extra inference service | Query/description vocabulary matters; misses synonyms or multilingual phrasing unless the model rewrites well |
| Jev ranks candidates | The retrieval benchmark supports better matching for its tested paraphrases and languages | Additional inference cost/latency; a threshold can hide a needed tool; the Hermes comparison showed no task-completion advantage |
| Provider-native discovery | Provider manages schema insertion, discovery state and cache placement; discovered functions become ordinary model tools | Depends on provider/model support and protocol-specific contracts |
| Generic search/describe/call functions | Portable across ordinary function-calling providers | The model handles an extra dispatch convention; full target argument validation belongs to the agent application, and discovery can require additional model requests |

This is an engineering interpretation, not a claim that the labs published these as their internal motivations. The relevant comparison remains complete task execution with the same catalog and model.

## Application to business-agent products

Limova publicly describes specialist business agents connected to services such as email, calendars, CRM, and social publishing. The public product material does not disclose its internal tool-discovery algorithm. Integration count alone is not the relevant model burden: only the tools authorized and connected for a particular agent/run matter.

Source: [Limova product](https://www.limova.ai/).

A business-agent application can separate ownership as follows:

1. The application owns connected accounts, roles, permissions, tool schemas, and execution. It constructs the authorized catalog before retrieval.
2. A retrieval backend accepts a task/query and that catalog, returning candidate IDs. Start with an existing lexical implementation; compare Jev as another backend. Neither owns authorization.
3. The main model obtains exact schemas and calls selected tools through the application's dispatcher. It can search again when the task changes or the first results are insufficient.

A CRM follow-up agent might search only email, CRM, and calendar tools permitted for its customer. It should not search every integration available to the whole platform. For a small role-specific tool set, direct tools may remain simpler and cheaper. For a large catalog, generic discovery avoids provider-specific implementation and makes changing models easier.

The reusable parts of this repository are the frozen catalog/task fixtures, retrieval/completion measurements, and candidate-selection logic. A comparison that replaces only native retrieval with live Jev remains untested. It would use one agent application and one GLM/MiMo model while keeping the catalog budget, model, permissions and executor unchanged. Include English/French tasks, missing capabilities, multi-step workflows, and scope changes. Measure completion, retries, peak context, cached/uncached input, output including reasoning, and latency. Account for Jev inference/network cost.

That experiment would test whether semantic retrieval improves completion enough to justify its additional cost and latency. The existing task-completion comparisons use fixed Jev selections rather than replacing only a native retrieval backend.

The [Hermes benchmark](../hermes/README.md) compares its complete native workflow
with fixed Jev selections on GLM-5.3-Flash. It does not isolate the retrieval backend.

## Source snapshots

Selected reviewed source files and their upstream license files are retained under `sources/`. [source-index.json](source-index.json) records repository, branch, exact commit, immutable raw URLs, and SHA-256 for every retained file. These snapshots are research evidence, not dependencies of the router or benchmark runtime. Provider/product web pages are linked above and can change after this review.
