---
name: pi-tooling
description: Manage Pi external CLI tools in isolated per-tool environments. Use when the user asks to sync, update, install, add, remove, or list tools, including installing a CLI tool from a GitHub URL.
---

# Pi Tooling

You manage external CLI tools through the user-level `~/.pi/agent/tools.yaml` and the Pi tooling extension.

Never install agent tools into the project virtualenv with `pip install`. Add tools to `~/.pi/agent/tools.yaml`, then run `/tools-sync`.

## Intents

- If the user says "sync the tools", "install missing tools", or similar: run `/tools-sync`.
- If the user says "update the tools", "upgrade tools", "refresh all tools", or similar: run `/tools-sync --update`.
- If the user asks to list/show tools: run `/tools-list`.
- If the user asks to install/add a tool: edit `~/.pi/agent/tools.yaml`, then run `/tools-sync` and `/tools-list`.

## Tool format

Use this YAML shape for Python CLI tools:

```yaml
tools:
  - name: example
    type: python
    package: example-package
    bins:
      - example
```

The `package` field is the exact `pip install` spec. The `bins` field is the command or commands expected to appear in the tool venv after install.

For GitHub Python tools, use the package spec given by the source repository's installation instructions when they exist. Only fall back to a direct Git URL when the source does not provide install instructions.

```yaml
  - name: repo-name
    type: python
    package: "git+https://github.com/owner/repo.git"
    bins:
      - inferred-command-name
```

## Installing from a GitHub URL

1. Inspect the repository before editing `~/.pi/agent/tools.yaml` unless the package and binary name are obvious.
2. Read the source repository's installation instructions, especially `README.md`, package-specific READMEs, and packaging metadata such as `pyproject.toml` or `setup.py`.
3. If the source provides installation instructions for the CLI, follow those instructions when choosing the `package` spec. Examples:
   - `pip install markitdown[all]` -> `package: "markitdown[all]"`
   - `pip install -e 'packages/tool[all]'` from a repo -> use the equivalent direct source/subdirectory package spec only if the tooling manager can install it reproducibly.
4. If source-provided installation instructions are found, do not silently substitute an alternate installation method when they fail. Error out and tell the user which source instruction failed and include the relevant failure reason.
5. Only if no source installation instructions are found, determine whether it is Python-installable by checking files such as `pyproject.toml` or `setup.py`, then infer a direct package spec such as `git+https://github.com/owner/repo.git` or a subdirectory spec.
6. Infer console scripts from project metadata or docs.
7. If the command name cannot be confidently inferred, ask the user for the bin name before editing.
8. Add one tool entry with an explicit `bins` list.
9. Run `/tools-sync`.
10. Run `/tools-list`.
11. Report the command(s) now available.

## Validation before syncing

Before running `/tools-sync`, verify:

- tool names are unique
- bin names are unique across enabled tools
- no bin uses a dangerous name: `python`, `python3`, `pip`, `pip3`, `node`, `npm`, `git`, `bash`, `sh`, `zsh`
- every tool has a non-empty `package`
- every tool has explicit `bins`

## Updating existing tools

Do not edit package specs just to update. Use `/tools-sync --update` so each configured tool is rebuilt in its own environment.
