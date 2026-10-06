# Setup

## Command unavailable

Register the bundled command once:

```sh
node "<skill-directory>/scripts/jev-skills-router.mjs" setup
```

Replace `<skill-directory>` with the directory containing `SKILL.md`. If setup reports `addToPath`, use the returned absolute `executable` as the command prefix. If registration fails, replace `jev-skills-router` in subsequent commands with `node "<skill-directory>/scripts/jev-skills-router.mjs"`.

For command options or an unclear error, run:

```sh
jev-skills-router --help
```

Use the same executable or bundled-script prefix if the command is not on PATH.

## Missing credentials

For `needs_setup` with `reason: api_key`, explain the returned message and render its `command` array as a quoted terminal command for the user to run in their own terminal. Never ask for or expose keys in chat or command arguments.

The manual command is:

```sh
jev-skills-router auth
```

## Empty catalog

For `needs_setup` with `reason: empty_catalog`, ask for a skill source to add, then use the [catalog instructions](catalog.md).

After resolving setup, rerun the original routing request with the original task text and loaded-skill paths.
