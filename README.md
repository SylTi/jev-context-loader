# jev-skills-router

Install one router skill with [skills](https://github.com/vercel-labs/skills), then let Jev select from your own catalog. The model initially sees the router's capability summary. Individual skill descriptions stay outside its context until selection. Every independent task match at or above 0.75 is disclosed.

Requires Node.js 22 or newer, npm, a locally installed or cached `skills` CLI, and your own TypeSafe API key for Jev. Runtime dependencies are bundled. No additional text model, local model runner, watcher, or hosted service operated by this project is required.

## Install

This workspace has no published repository source yet. From its root, install the bundled skill and choose your agents in the upstream prompt:

```sh
npx skills add .
```

Choose project or global installation. To specify global scope directly:

```sh
npx skills add . --global
```

When published, the same flow will accept its repository source. Upstream currently does not resolve a bare `jev-skills-router` marketplace alias. A repository URL or local path is required; this bundle cannot create that alias itself.

On the first model invocation, the router reports any setup decisions. The model asks how to handle imported originals and whether to share skills absent from some chosen providers. It gives you the exact terminal command for entering your key privately if needed. Installation itself has no post-install hook or secret prompt.

The default shared project location is `.agents/skills/jev-skills-router`, and the default global location is `~/.agents/skills/jev-skills-router`. Native copied installations are also discovered through your installed CLI. The skill uses `jev-skills-router` and registers the bundled command on first use if it is unavailable. You can also register it manually once:

```sh
node .agents/skills/jev-skills-router/scripts/jev-skills-router.mjs setup
```

After global installation, use the installed path, for example on Linux, macOS or WSL:

```sh
node "$HOME/.agents/skills/jev-skills-router/scripts/jev-skills-router.mjs" setup
```

In Windows PowerShell:

```powershell
node "$env:USERPROFILE\.agents\skills\jev-skills-router\scripts\jev-skills-router.mjs" setup
```

`setup` writes a POSIX executable or Windows `.cmd` launcher to npm's global bin directory. Use `--bin-dir PATH` for another writable directory. It reports a PATH instruction when needed and never edits shell profiles. Set up separately within WSL when using WSL agents.

## npm CLI distribution

The package also exposes the standard npm executable `jev-skills-router`. For local development, install the existing bundle from this checkout:

```sh
npm install --global .
jev-skills-router --help
```

`npm pack` builds a tarball containing the skill and bundled launchers, without source files, tests, or development dependencies. Install that tarball with `npm install --global /path/to/jev-skills-router-0.1.0.tgz` to distribute the CLI before publication. npm creates the platform's command wrappers, including Windows wrappers. Node.js is still required.

After npm publication, users could run:

```sh
npx jev-skills-router --help
# Or install the command once:
npm install --global jev-skills-router
jev-skills-router add owner/repo --skill selected-skill
```

The package remains private and unpublished for now. npm installs the CLI; `npx skills add` installs the skill into the chosen agents. Catalog commands resolve the applicable installed routers from the working directory, so installing the CLI does not replace agent installation or change scope rules. `path` prints the directory containing the running CLI.

## Use your own skills

```sh
jev-skills-router auth
jev-skills-router add /path/to/complete-skill
jev-skills-router add /path/to/custom.md
jev-skills-router add owner/repo --skill selected-skill
jev-skills-router update
jev-skills-router discover --reset
```

`auth` prompts without echo, validates the key with Jev, and stores it in a private user configuration file. Never provide keys in chat or command arguments. `TYPESAFE_API_KEY` overrides the saved key. Credentials use `$XDG_CONFIG_HOME/jev-skills-router/credentials.json` or `~/.config/jev-skills-router/credentials.json` on Linux and WSL, `~/Library/Application Support/jev-skills-router/credentials.json` on macOS, and `%APPDATA%\jev-skills-router\credentials.json` on Windows. The file stores the key locally, not in a project or repository.

Complete folders and repository sources use your existing `skills add` CLI underneath and preserve scripts and resources. Markdown imports copy just that file. If only one applicable router exists, `add` selects it. If both global and project routers exist, it asks where to add and shows the paths. `--global` or `--project` makes the choice explicit. The project installation is found from the current directory or its ancestors, without treating every Git repository as a router project.

Each scope's durable catalog is `<scope-root>/.agents/jev-skills-router/skills/`, outside the installed router. The global root is your home directory; the project root is the nearest installed project. Decisions, backups, and caches are siblings of this catalog. Reinstalling the router preserves them. You may copy skill files or folders directly into this catalog. Files copied into the installed router's `skills/` directory move to the durable catalog on its next invocation.

`update` runs your existing `skills update --project --yes` within applicable private catalogs. Source records retain upstream update behavior; manually copied and local skills remain user-maintained. Router updates themselves still use `npx skills`. The script neither downloads nor upgrades the upstream CLI automatically. It checks an explicit `JEV_SKILLS_ROUTER_SKILLS_CLI` path, local installation, PATH, npm global installation, then recently used npx cache entries. If that CLI lacks JSON inventory support, it reports the required explicit update.

## Import and scope rules

A global router scans global installations only. A project router scans that project only. When both apply, routing combines both catalogs and **global wins on duplicate declared skill names**. Project data stays within its project. A shared catalog has no caller-specific routing profile.

The participating providers are those where this scope's router is installed. Skills common to all of them are imported automatically. For other skills, you decide individually whether to share them through that scope's router. Declines are remembered until their name or description changes, explicit `add` requests them, or `--reset` clears the ignored list. Reset preserves credentials, catalog contents, and classifications.

The original-handling choice applies to existing and future imports:

| Policy | Original after verified import |
| --- | --- |
| `disable` | Removed from active discovery; imported copy retained in Jev's catalog, plus a separate restorable backup of the original. |
| `delete` | Removed from active discovery; imported copy retained in Jev's catalog. |
| `keep` | Remains active and continues to cost discovery context. |

The script copies and verifies contents before changing the original. If an original is also associated with a provider outside this router installation, it reports the conflict and leaves that original active. External `npx skills add` changes are handled on the next router invocation. No background process is required.

Upstream inventory can collapse distinct same-name installations into one entry. After removing an original, Jev rediscovers to handle any remaining copies. With `keep`, that upstream inventory limitation also limits which same-name source variant can be imported. A shared global catalog resolves names consistently rather than preserving per-provider differences.

## Description and routing

Jev classifies metadata against 1,172 canonical task categories across 32 domains. Each skill can match multiple domains and categories at or above 0.75. Descriptions include every accepted domain alongside matched detailed categories, within 1024 characters. When all details do not fit, the summary selects shorter matched category labels, giving distinct domains a detailed match before filling the remaining space. It never cuts labels mid-word. The cache retains every match; the description contains only the subset that fits. Unclassified skills contribute no capability labels but remain candidates whenever the router is invoked. If the entire catalog is unclassified, the description advertises explicit router use only. If a broad domain matches but no detailed category does, the summary retains that domain.

Classification cache keys are exactly:

```text
sha256(sha256(name) + sha256(description))
```

Inner digests are lowercase hexadecimal strings. Every invocation discovers files again. Only changed names or descriptions are reclassified. Each changed metadata record first gets one request containing an independent Noul question for each of the 32 broad domains. Only domains scoring at least 0.75 admit detailed categories. Their combined category set is evaluated in batches of at most 128 questions, with each shared category evaluated once. Both accepted domain labels and detailed category IDs are cached only after all stages succeed. Body and resource changes still affect copied contents and disclosure, without reclassification. The cache also hashes the taxonomy and parent memberships, domain definitions, both classification questions, hierarchy strategy, and threshold; changing those invalidates classifications.

The taxonomy separates UI and interaction design, UX research and design, design systems and accessibility, visual design, and physical design. Software testing and quality, physical product testing and quality, and manufacturing quality have separate scopes. Ambiguous labels are qualified, such as software performance testing and financial risk analysis. Shared tasks have multiple parent domains, so UX writing is reachable through writing or UX, reliability engineering through hardware or operations, and statistical process control through manufacturing or data analysis. It also deepens software, documents, data, operations, marketing, science, audio, 3D, education, and the other domains. Labels describe task families rather than enumerating skill providers.

For a new skill, the request count is `1 + ceil(reachable_unique_categories / 128)`. A skill with no accepted broad domain uses one request; unchanged metadata uses none. Domain definitions ask whether the skill supports any intended task in that domain, rather than requiring the entire domain to apply. Independent model scores can still disagree between parent and child; retaining an accepted parent preserves the known capability without inventing a detailed match.

The taxonomy never filters task candidates. For routing, Jev judges every not-yet-loaded candidate's original name and description independently in one request. It receives task text, metadata, and category definitions. Bodies and local paths stay local. The probability cutoff is a selection policy, not a measured accuracy guarantee.

Models route new tasks matching the capability summary before starting work. They reuse routing results and disclosed skills while continuing the same task, including a successful empty result. They route again only on material scope changes or an explicit user request. Calls use the bundled command with literal task text on stdin:

```sh
jev-skills-router route --json --loaded /absolute/path/to/loaded/SKILL.md
```

The script owns discovery, imports, classification, and description writes. The CLI returns typed readiness states so a model cannot mistake missing setup for no applicable skills:

| Status | Meaning |
| --- | --- |
| `ready` with `skills` | All selected instructions, or a successful empty list. |
| `ready` with `skillCount` | Catalog management completed. |
| `needs_decision` | Original policy or an uncommon skill needs a user choice. |
| `needs_setup` | API credentials or a first task skill is missing. |
| `scope_required` | Choose between applicable global and project destinations. |
| `scope_conflict` | A new project copy is shadowed by a global skill. |
| `needs_attention` | An original remains active because removal would affect another provider. |

Model-facing decisions expose only the candidate names, paths, and provider associations needed for consent, rather than the metadata catalog. `configure --policy VALUE`, `accept --candidate ID`, and `ignore --candidate ID` record decisions, with the request's `--global` or `--project` flag. `--json` returns questions instead of opening terminal prompts.

Selected entries contain `name`, `description`, `path`, `instructions`, and `matchProbability`. Relative resources resolve from the returned skill directory. A nonzero exit reports failure on stderr, never a partial successful selection. The router executes no disclosed skill instructions and grants no additional permissions.

Advanced explicit catalog routing remains available through repeated `--skills-root PATH` or `JEV_SKILLS_ROUTER_ROOTS`, a JSON array. This bypasses managed import and scope handling and returns the simple `{"skills": [...]}` result. `scripts/route.mjs` is a compatibility entry point.

## Languages

Category labels and generated capability summaries are English. Routing passes the task in its original language and compares it directly with the skills' original names and descriptions. Categories are used only to summarize the catalog, not as an intermediate task-routing step.

Jev's Noul response is a numeric probability, not prose in a selected language. Returned skill metadata and instructions keep their original language. The invoking assistant continues speaking the user's conversation language.

[TypeSafe documents multilingual input support](https://docs.typesafe.ai/models#language-support), but says accuracy is strongest in English. A French task and English skill metadata therefore rely on Jev's cross-language semantic judgment. Transport and disclosure tests preserve French Unicode and mixed-language metadata; mocked tests do not establish French routing accuracy. A live bilingual evaluation is needed before claiming parity with English. Translating only the task into English in the invoking model is a possible integration choice and does not expose the hidden catalog; the router does not silently perform translation or call another service.

## Cost estimates

These estimates compare skill discovery and routing overhead using **Claude Fable 5.1**. They do not estimate the total task bill or measured changes in model performance.

Rates checked on October 6, 2026, in USD per million tokens:

| Model | Input | Output | 5-minute cache write | Cache read |
| --- | ---: | ---: | ---: | ---: |
| Claude Fable 5.1 | $10.00 | $50.00 | $12.50 | $0.25 |
| Jev 1.13 | $0.042 | Free | Not modeled | Not modeled |

Sources: [Anthropic pricing](https://platform.claude.com/docs/en/about-claude/pricing) and [TypeSafe model pricing](https://docs.typesafe.ai/models).

### Assumptions

- Regular discovery uses **78 tokens per skill's name and description**. This rounded estimate comes from a local sample of 20 user-installed skills after excluding the three shortest descriptions: `simplify`, `ui-skills`, and `tdd`. Larger catalogs extrapolate that average.
- The router uses **550 tokens**, including the lean `SKILL.md` body and a generated capability description at its 1,024-character limit. The calculated estimate is about 517 tokens, rounded up. Actual summaries can be shorter.
- Token estimates use characters divided by four, not the models' actual tokenizers.
- Every fresh task invokes the router once. Classification is already cached, and the task does not change scope enough to require rerouting.
- Each task pays one 5-minute cache write for this content as part of the cached prompt. Every subsequent model request reads it from cache, with no expiry, invalidation, or compaction.
- A Jev routing call uses an estimated 22.5 task tokens plus 158.3625 tokens per candidate, based on the sample routing payload. Every catalog skill is a candidate on the first call.
- Shared conversation content and selected skill instructions are assumed to cost the same in both approaches. Additional router tool messages, reasoning/output, setup and catalog guide loads, initial classification, and cache misses are excluded.

### Initial discovery and routing cost per fresh task

| Skills | Regular skill catalog | Jev router + routing call | Saving |
| ---: | ---: | ---: | ---: |
| 5 | $0.00488 | $0.00691 | −$0.00203 |
| 10 | $0.00975 | $0.00694 | $0.00281 |
| 20 | $0.01950 | $0.00701 | $0.01249 |
| 50 | $0.04875 | $0.00721 | $0.04154 |
| 100 | $0.09750 | $0.00754 | $0.08996 |

### Total savings across 100 fresh tasks

These figures include the initial cache write and every subsequent cache read. Each column gives the number of Fable API requests per task. Negative savings mean the router costs more under these assumptions.

| Skills | 20 requests/task | 100 requests/task | 500 requests/task |
| ---: | ---: | ---: | ---: |
| 5 | −$0.28 | −$0.60 | −$2.20 |
| 10 | $0.39 | $0.85 | $3.15 |
| 20 | $1.73 | $3.75 | $13.85 |
| 50 | $5.75 | $12.45 | $45.95 |
| 100 | $12.44 | $26.94 | $99.44 |

For `N` skills and `R` requests per task, the calculation is:

```text
Jev routing cost = (22.5 + N × 158.3625) × 0.042 / 1,000,000
Initial regular cost = N × 78 × 12.50 / 1,000,000
Initial router cost = 550 × 12.50 / 1,000,000 + Jev routing cost
Savings over 100 tasks = 100 × (
  (N × 78 − 550) × (12.50 + (R − 1) × 0.25) / 1,000,000
  − Jev routing cost
)
```

## Development and verification

```sh
npm --prefix jev-skills-router ci
npm --prefix jev-skills-router run typecheck
npm --prefix jev-skills-router test
npm --prefix jev-skills-router run build
npx skills --help
npm --prefix jev-skills-router run test:install
```

Build generates self-contained `scripts/jev-skills-router.mjs` and `scripts/route.mjs`. Ship them with `SKILL.md`. Installation tests use the real locally available CLI in isolated home and project directories, including paths with spaces. API responses are mocked. They cover installation, native command invocation, imports, ignored decisions, scope precedence, resources, and router reinstallation.

GitHub Actions defines native Linux, Windows, macOS, and WSL 2 checks. This standalone workspace cannot dispatch them until it is published. Live Jev classification and routing accuracy require a user key and a labeled sample catalog; mocked checks do not measure them.
