# pi-tooling

A Pi package for external CLI tools in isolated per-tool environments.

The package provides:

- an extension with `/tools-sync`, `/tools-sync --update`, and `/tools-list`
- a `pi-tooling` skill so natural language like “update the tools” or “install the tool at https://github.com/owner/repo” works

## Install

Project-local, for a synced project `.pi/settings.json`:

```bash
pi install -l git:github.com/p-baum/pi-tooling
```

Or add it manually:

```json
{
  "packages": [
    "git:github.com/p-baum/pi-tooling"
  ]
}
```

Global install:

```bash
pi install git:github.com/p-baum/pi-tooling
```

## Tool config

Tools are always configured and installed at the user level. On startup, the extension creates `~/.pi/agent/tools.yaml` with commented format documentation if it does not already exist.

Example `~/.pi/agent/tools.yaml`:

```yaml
tooling:
  rootDir: ~/.pi/agent/tooling
  pythonCommand:
    - python3
  injectPath: true

tools:
  - name: markitdown
    type: python
    package: "markitdown[all]"
    bins:
      - markitdown
```

## Commands

```text
/tools-sync           Install missing or changed tools
/tools-sync --update  Rebuild/update all configured tools
/tool-sync update     Alias for /tools-sync --update
/tools-list           Show configured tools, bins, and venv paths
```

In non-interactive/print mode, these commands write progress and warnings to stdout/stderr.

Tools are installed under:

```text
~/.pi/agent/tooling/
  venvs/<tool-name>/
  bin/<shim>
  manifests/<tool-name>.json
```

Only the shim directory is injected into Bash `PATH` for Pi tool calls. Tools are rebuilt only when their own fingerprint changes, or when `/tools-sync --update` is used.

## Natural language

The included skill handles requests like:

- “update the tools”
- “sync the tools”
- “install the tool at https://github.com/owner/repo”
- “make this CLI available to Pi”

The skill edits `~/.pi/agent/tools.yaml`, validates names/bins, runs `/tools-sync`, and lists the result.
