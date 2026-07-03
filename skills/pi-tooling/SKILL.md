---
name: pi-tooling
description: Manage Pi external CLI tools in isolated per-tool environments. Use when the user asks to sync, update, install, add, remove, or list tools, including installing a CLI tool from a GitHub URL.
---

# Pi Tooling

You manage external CLI tools through the user-level `~/.pi/agent/tools.yaml` and the Pi tooling extension.

Never install agent tools into the project virtualenv with `pip install`. Add tools to `~/.pi/agent/tools.yaml`, then run `/tools-sync`.

Prefer the best supported Python version for each tool, not necessarily the system `python3`. If the system Python version is newer/older than the tool's supported range, install a private Python with `uv` under `~/.pi/agent/tooling` and point the tool or tooling config at that exact interpreter path. Do not require root and do not install Python into the user's global environment.

## Intents

- If the user says "sync the tools", "install missing tools", or similar: run `/tools-sync`.
- If the user says "update the tools", "upgrade tools", "refresh all tools", or similar: run `/tools-sync --update`. `/tool-sync update` is accepted as a compatibility alias, but prefer the canonical command.
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

Use `pythonCommand` when a tool needs a specific interpreter:

```yaml
  - name: example
    type: python
    package: example-package
    bins:
      - example
    pythonCommand: /home/paul/.pi/agent/tooling/pythons/cpython-3.12-linux-x86_64-gnu/bin/python3.12
```

Use an exact path; do not use shell globs.

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
3. Determine the best Python version for the tool:
   - Prefer explicit docs first: README prerequisites, `requires-python` in `pyproject.toml`, classifiers, setup metadata, or CI matrices.
   - Choose a stable version inside the supported range, usually Python 3.12 when supported.
   - If the current system Python differs from the best supported version, use a private Python under `~/.pi/agent/tooling` as described in [Private Python versions](#private-python-versions), then add `pythonCommand` to the tool entry or set the global `tooling.pythonCommand` if it should be the default for all tools.
4. If the source provides installation instructions for the CLI, follow those instructions when choosing the `package` spec. Examples:
   - `pip install markitdown[all]` -> `package: "markitdown[all]"`
   - `pip install -e 'packages/tool[all]'` from a repo -> use the equivalent direct source/subdirectory package spec only if the tooling manager can install it reproducibly.
5. If source-provided installation instructions are found, do not silently substitute an alternate installation method when they fail. Error out and tell the user which source instruction failed and include the relevant failure reason.
6. Only if no source installation instructions are found, determine whether it is Python-installable by checking files such as `pyproject.toml` or `setup.py`, then infer a direct package spec such as `git+https://github.com/owner/repo.git` or a subdirectory spec.
7. Infer console scripts from project metadata or docs.
8. If the command name cannot be confidently inferred, ask the user for the bin name before editing.
9. Add one tool entry with an explicit `bins` list and, when needed, an explicit `pythonCommand`.
10. Run `/tools-sync`.
11. Run `/tools-list`.
12. Report the command(s) now available and the Python version used.

## Private Python versions

Use this when the best Python version for a tool differs from the system Python or the system Python produces an incompatible/old package resolution.

1. Check for private uv:

```bash
~/.pi/agent/tooling/uv/bin/uv --version
```

2. If missing, install uv privately under the Pi tooling directory:

```bash
export UV_INSTALL_DIR="$HOME/.pi/agent/tooling/uv/bin"
mkdir -p "$UV_INSTALL_DIR"
curl -LsSf https://astral.sh/uv/install.sh | sh
```

3. Install the chosen Python privately:

```bash
UV_PYTHON_INSTALL_DIR="$HOME/.pi/agent/tooling/pythons" \
  "$HOME/.pi/agent/tooling/uv/bin/uv" python install 3.12
```

4. Resolve the exact interpreter path:

```bash
UV_PYTHON_INSTALL_DIR="$HOME/.pi/agent/tooling/pythons" \
  "$HOME/.pi/agent/tooling/uv/bin/uv" python find 3.12
```

5. Use that exact path in `pythonCommand`. Prefer a per-tool `pythonCommand` when only one tool needs it; use top-level `tooling.pythonCommand` when making it the default for all tools.

## Validation before syncing

Before running `/tools-sync`, verify:

- tool names are unique
- bin names are unique across enabled tools
- no bin uses a dangerous name: `python`, `python3`, `pip`, `pip3`, `node`, `npm`, `git`, `bash`, `sh`, `zsh`
- every tool has a non-empty `package`
- every tool has explicit `bins`

## Updating existing tools

Do not edit package specs just to update. Use `/tools-sync --update` so each configured tool is rebuilt in its own environment.
