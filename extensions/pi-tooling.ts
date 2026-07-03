import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { isToolCallEventType, type ExtensionAPI, type ExtensionCommandContext, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { parse as parseYaml } from "yaml";

type PythonToolConfig = {
	name: string;
	type: "python";
	packageSpec: string;
	bins: string[];
	disabled: boolean;
	pythonCommand?: string[];
	installArgs: string[];
	origin: string;
};

type ToolConfig = PythonToolConfig;

type ToolingConfig = {
	rootDir: string;
	venvDir: string;
	binDir: string;
	manifestDir: string;
	pythonCommand: string[];
	injectPath: boolean;
};

type RuntimeConfig = {
	tools: ToolConfig[];
	tooling: ToolingConfig;
	configPaths: string[];
	warnings: string[];
};

type SyncOptions = { installMissing: boolean; update: boolean };
type FeedbackLevel = "info" | "warning" | "error";
type ProgressReporter = (message: string, level?: FeedbackLevel) => void;
type ToolSyncResult = { installedOrUpdated: number; warnings: string[] };
type InstallResult = { warnings: string[] };
type ToolManifest = { bins?: unknown; fingerprint?: unknown };
type ToolingState = { rootDir: string; venvDir?: string; binDir?: string; manifestDir?: string; pythonCommand: string[]; injectPath: boolean };

const DEFAULT_TOOLING_DIR_NAME = "tooling";
const DEFAULT_PYTHON_COMMAND = ["python3"];
const COMMAND_TIMEOUT_MS = 5 * 60 * 1000;
const TOOLING_BASH_MARKER = "# pi-tooling begin";
const CONFIG_FILE_NAME = "tools.yaml";
const DANGEROUS_SHIM_NAMES = new Set(["bash", "git", "node", "npm", "npx", "pip", "pip3", "python", "python3", "sh", "zsh"]);
const BUILT_IN_TOOL_NAMES = new Set(["read", "bash", "edit", "write", "grep", "find", "ls"]);
const REGISTERED_TOOL_NAMES = new Set<string>();
const DEFAULT_USER_TOOLS_CONFIG = `# Pi-managed external CLI tools.
#
# This file is loaded from ~/.pi/agent/tools.yaml. Tools are managed only at
# the user level, not per project.
#
# Top-level keys:
#   tooling: optional manager settings
#   tools:   list of tool declarations
#
# tooling:
#   # Directory that stores virtualenvs, generated shims, and manifests.
#   rootDir: ~/.pi/agent/tooling
#   # Command used to create Python virtualenvs. Either a string or a list.
#   pythonCommand: python3
#   # Whether Pi should put generated shims on PATH for bash tool calls.
#   injectPath: true
#
# tools:
#   - name: example
#     # Only Python tools are currently supported; type defaults to python.
#     type: python
#     # Any pip-installable package spec, including version pins or git URLs.
#     package: example-package
#     # Command names to expose. If omitted, defaults to the tool name.
#     bins: [example]
#     # Optional extra args passed to: pip install --upgrade ... <package>
#     installArgs: []
#     # Optional per-tool virtualenv creation command override.
#     # pythonCommand: [uv, python]
#     # Set true to keep the declaration without installing/exposing it.
#     disabled: true

tooling:
  rootDir: ~/.pi/agent/tooling
  pythonCommand: python3
  injectPath: true

tools: []
`;

export default function piTooling(pi: ExtensionAPI) {
	void ensureUserToolsConfigFile();

	pi.on("tool_call", async (event, _ctx) => {
		if (!isToolCallEventType("bash", event)) return;
		const config = await loadRuntimeConfig();
		if (!config.tooling.injectPath || countEnabledTools(config) === 0) return;
		event.input.command = injectToolingPath(event.input.command, config.tooling);
	});

	pi.on("session_start", async (_event, _ctx) => {
		await registerConfiguredTools(pi);
	});

	pi.on("before_agent_start", async (event, _ctx) => {
		const config = await loadRuntimeConfig();
		const guidance = toolingPromptGuidance(config);
		if (!guidance) return;
		return { systemPrompt: `${event.systemPrompt}\n\n${guidance}` };
	});

	registerToolsSyncCommand(pi);
	registerToolsListCommand(pi);
}

function registerToolsSyncCommand(pi: ExtensionAPI) {
	const handler = async (args: string, ctx: ExtensionCommandContext) => {
		const transcript: string[] = [];
		const report: ProgressReporter = (message, level = "info") => {
			transcript.push(formatFeedbackLine(message, level));
			emitFeedback(ctx, message, level);
		};
		const parsedArgs = splitArgs(args);
		const update = parsedArgs.includes("--update") || parsedArgs.includes("update");
		const unknownArgs = parsedArgs.filter((arg) => arg !== "--update" && arg !== "update");
		if (unknownArgs.length > 0) report(`Tools: ignoring unknown argument(s): ${unknownArgs.join(", ")}`, "warning");
		const config = await loadRuntimeConfig();
		notifyWarnings(ctx, config.warnings, "Tools", report);
		const toolCount = countEnabledTools(config);
		if (toolCount === 0) {
			report("Tools: no enabled tools configured.", "warning");
			sendCommandReport(pi, "tools-sync", transcript);
			return;
		}
		report(`Tools: syncing ${toolCount} tool(s)${update ? " with updates" : ""}...`, "info");
		const result = await syncTools(pi, config, { installMissing: true, update }, report);
		await registerConfiguredTools(pi);
		report(`Tools: installed/updated ${result.installedOrUpdated} tool(s).`, result.warnings.length > 0 ? "warning" : "info");
		sendCommandReport(pi, "tools-sync", transcript);
	};

	pi.registerCommand("tools-sync", {
		description: "Install/update configured Pi-managed tools",
		handler,
	});
	pi.registerCommand("tool-sync", {
		description: "Alias for /tools-sync",
		handler,
	});
}

function registerToolsListCommand(pi: ExtensionAPI) {
	pi.registerCommand("tools-list", {
		description: "List configured Pi-managed tools",
		handler: async (_args, ctx) => {
			const config = await loadRuntimeConfig();
			const transcript: string[] = [];
			const report: ProgressReporter = (message, level = "info") => {
				transcript.push(formatFeedbackLine(message, level));
				emitFeedback(ctx, message, level);
			};
			notifyWarnings(ctx, config.warnings, "Tools", report);
			if (config.tools.length === 0) {
				report("Tools: no tools configured.", "warning");
				sendCommandReport(pi, "tools-list", transcript);
				return;
			}
			const lines = config.tools.flatMap((tool, index) => {
				const disabled = tool.disabled ? " (disabled)" : "";
				return [`${index + 1}. ${tool.name}${disabled}`, `   package: ${tool.packageSpec}`, `   bins: ${tool.bins.join(", ")}`, `   venv: ${displayPath(toolVenvDir(config.tooling, tool))}`];
			});
			report(`Pi-managed tools:\n${lines.join("\n")}`, "info");
			sendCommandReport(pi, "tools-list", transcript);
		},
	});
}

async function registerConfiguredTools(pi: ExtensionAPI) {
	const config = await loadRuntimeConfig();
	const active = new Set(pi.getActiveTools());
	const currentlyConfiguredToolNames = new Set<string>();
	const reservedBins = new Set(config.tools.filter((tool) => !tool.disabled).flatMap((tool) => tool.bins));
	for (const tool of config.tools.filter((candidate) => !candidate.disabled)) {
		for (const bin of tool.bins) {
			const toolName = piToolNameForBin(bin);
			currentlyConfiguredToolNames.add(toolName);
			REGISTERED_TOOL_NAMES.add(toolName);
			pi.registerTool({
				name: toolName,
				label: bin,
				description: `Run the Pi-managed command-line tool ${bin}.`,
				promptSnippet: `Run the Pi-managed command-line tool ${bin}`,
				promptGuidelines: [`Use ${toolName} when the user asks to run the ${bin} CLI tool directly.`],
				parameters: Type.Object({
					args: Type.Optional(Type.Array(Type.String(), { description: `Arguments to pass to ${bin}. Do not include the command name itself.` })),
					cwd: Type.Optional(Type.String({ description: "Working directory. Relative paths are resolved from the current project directory." })),
				}),
				async execute(_toolCallId, params, signal, _onUpdate, ctx) {
					await ensurePythonTool(pi, tool, config.tooling, { installMissing: false, update: false }, reservedBins);
					const cwd = typeof params.cwd === "string" && params.cwd.trim() ? resolve(ctx.cwd, params.cwd) : ctx.cwd;
					const result = await pi.exec(bin, params.args ?? [], { cwd, signal, timeout: COMMAND_TIMEOUT_MS });
					const text = [`exit code: ${result.code}`, result.stdout ? `stdout:\n${result.stdout}` : undefined, result.stderr ? `stderr:\n${result.stderr}` : undefined].filter(Boolean).join("\n\n");
					return { content: [{ type: "text", text }], details: { bin, args: params.args ?? [], cwd, code: result.code, stdout: result.stdout, stderr: result.stderr } };
				},
			});
			active.add(toolName);
		}
	}
	for (const name of pi.getActiveTools()) {
		if (REGISTERED_TOOL_NAMES.has(name) && !currentlyConfiguredToolNames.has(name)) active.delete(name);
	}
	pi.setActiveTools([...active]);
}

async function ensureUserToolsConfigFile() {
	const configPath = join(getAgentDir(), CONFIG_FILE_NAME);
	try {
		await mkdir(dirname(configPath), { recursive: true });
		await writeFile(configPath, DEFAULT_USER_TOOLS_CONFIG, { encoding: "utf8", flag: "wx" });
	} catch (error) {
		if (isRecord(error) && error.code === "EEXIST") return;
		console.warn(`Tools: could not create default ${configPath}: ${error instanceof Error ? error.message : String(error)}`);
	}
}

async function loadRuntimeConfig(): Promise<RuntimeConfig> {
	const agentDir = getAgentDir();
	const candidates = [join(agentDir, CONFIG_FILE_NAME)];
	const loaded: Array<{ path: string; data?: unknown; error?: string }> = [];
	for (const path of candidates) {
		if (!existsSync(path)) continue;
		try { loaded.push({ path, data: parseYaml(await readFile(path, "utf8")) as unknown }); }
		catch (error) { loaded.push({ path, error: error instanceof Error ? error.message : String(error) }); }
	}
	const warnings = loaded.filter((entry) => entry.error).map((entry) => `${entry.path}: ${entry.error}`);
	const toolingState: ToolingState = { rootDir: join(agentDir, DEFAULT_TOOLING_DIR_NAME), pythonCommand: [...DEFAULT_PYTHON_COMMAND], injectPath: true };
	const tools: ToolConfig[] = [];
	for (const entry of loaded) {
		if (entry.error) continue;
		if (!isRecord(entry.data)) { warnings.push(`${entry.path}: expected an object.`); continue; }
		if (isRecord(entry.data.tooling)) applyToolingConfig(toolingState, entry.data.tooling, dirname(entry.path), entry.path, warnings);
		if (Array.isArray(entry.data.tools)) appendTools(tools, entry.data.tools, entry.path, warnings);
	}
	return { tools: dedupeTools(tools, warnings), tooling: finalizeToolingConfig(toolingState), configPaths: loaded.map((entry) => entry.path), warnings };
}

function appendTools(target: ToolConfig[], rawTools: unknown[], origin: string, warnings: string[]) {
	for (const [index, rawTool] of rawTools.entries()) {
		const tool = normalizeRawTool(rawTool, origin, index, warnings);
		if (tool) target.push(tool);
	}
}

function normalizeRawTool(rawTool: unknown, origin: string, index: number, warnings: string[]): ToolConfig | undefined {
	const label = `${origin}: tools[${index}]`;
	if (!isRecord(rawTool)) { warnings.push(`${label} must be an object.`); return undefined; }
	const name = typeof rawTool.name === "string" ? rawTool.name.trim() : "";
	if (!name) { warnings.push(`${label}.name is required.`); return undefined; }
	if (!isSafeToolName(name)) { warnings.push(`${label}.name must contain only letters, numbers, dots, underscores, and hyphens.`); return undefined; }
	const type = typeof rawTool.type === "string" ? rawTool.type : "python";
	if (type !== "python") { warnings.push(`${label}.type ${JSON.stringify(type)} is not supported; only "python" is currently supported.`); return undefined; }
	const packageSpec = typeof rawTool.package === "string" ? rawTool.package.trim() : "";
	if (!packageSpec) { warnings.push(`${label}.package is required for python tools.`); return undefined; }
	const bins = normalizeToolBins(rawTool.bins, name, label, warnings);
	if (!bins) return undefined;
	const pythonCommand = normalizeCommand(rawTool.pythonCommand, `${label}.pythonCommand`, warnings);
	const installArgs = normalizeStringList(rawTool.installArgs, `${label}.installArgs`, warnings) ?? [];
	return { name, type: "python", packageSpec, bins, disabled: rawTool.disabled === true, pythonCommand, installArgs, origin };
}

function normalizeToolBins(value: unknown, fallbackName: string, label: string, warnings: string[]): string[] | undefined {
	let bins: string[];
	if (value === undefined) bins = [fallbackName];
	else if (Array.isArray(value)) bins = value.filter((item): item is string => typeof item === "string").map((item) => item.trim());
	else if (typeof value === "string") bins = [value.trim()];
	else { warnings.push(`${label}.bins must be a string or an array of strings when provided.`); return undefined; }
	bins = [...new Set(bins.filter(Boolean))];
	if (bins.length === 0) { warnings.push(`${label}.bins must contain at least one command name.`); return undefined; }
	for (const bin of bins) {
		if (!isSafeBinName(bin)) { warnings.push(`${label}.bins contains invalid command name ${JSON.stringify(bin)}.`); return undefined; }
		if (DANGEROUS_SHIM_NAMES.has(bin)) { warnings.push(`${label}.bins contains dangerous shim name ${JSON.stringify(bin)}; choose a tool-specific command name.`); return undefined; }
	}
	return bins;
}

function applyToolingConfig(state: ToolingState, rawTooling: Record<string, unknown>, baseDir: string, origin: string, warnings: string[]) {
	if (typeof rawTooling.rootDir === "string") state.rootDir = expandPath(rawTooling.rootDir, baseDir);
	if (typeof rawTooling.venvDir === "string") state.venvDir = expandPath(rawTooling.venvDir, baseDir);
	if (typeof rawTooling.binDir === "string") state.binDir = expandPath(rawTooling.binDir, baseDir);
	if (typeof rawTooling.manifestDir === "string") state.manifestDir = expandPath(rawTooling.manifestDir, baseDir);
	if (typeof rawTooling.injectPath === "boolean") state.injectPath = rawTooling.injectPath;
	const pythonCommand = normalizeCommand(rawTooling.pythonCommand, `${origin}: tooling.pythonCommand`, warnings);
	if (pythonCommand) state.pythonCommand = pythonCommand;
}

function finalizeToolingConfig(state: ToolingState): ToolingConfig {
	return { rootDir: state.rootDir, venvDir: state.venvDir ?? join(state.rootDir, "venvs"), binDir: state.binDir ?? join(state.rootDir, "bin"), manifestDir: state.manifestDir ?? join(state.rootDir, "manifests"), pythonCommand: state.pythonCommand.length > 0 ? state.pythonCommand : [...DEFAULT_PYTHON_COMMAND], injectPath: state.injectPath };
}

async function syncTools(pi: ExtensionAPI, config: RuntimeConfig, options: SyncOptions, report?: ProgressReporter): Promise<ToolSyncResult> {
	const tools = config.tools.filter((tool) => !tool.disabled);
	if (tools.length === 0) return { installedOrUpdated: 0, warnings: [] };
	await mkdir(config.tooling.venvDir, { recursive: true });
	await mkdir(config.tooling.binDir, { recursive: true });
	await mkdir(config.tooling.manifestDir, { recursive: true });
	const warnings: string[] = [];
	let installedOrUpdated = 0;
	const reservedBins = new Set(tools.flatMap((tool) => tool.bins));
	for (const tool of tools) {
		report?.(`Tools: ${tool.name}: checking...`, "info");
		try {
			const result = await ensurePythonTool(pi, tool, config.tooling, options, reservedBins, report);
			if (result.changed) {
				installedOrUpdated += 1;
				report?.(`Tools: ${tool.name}: installed/updated.`, "info");
			} else {
				report?.(`Tools: ${tool.name}: already up to date.`, "info");
			}
			for (const warning of result.warnings) {
				const message = `${tool.name}: ${warning}`;
				warnings.push(message);
				report?.(`Tools: ${message}`, "warning");
			}
		}
		catch (error) {
			const message = `${tool.name}: ${error instanceof Error ? error.message : String(error)}`;
			warnings.push(message);
			report?.(`Tools: ${message}`, "warning");
		}
	}
	return { installedOrUpdated, warnings };
}

async function ensurePythonTool(pi: ExtensionAPI, tool: ToolConfig, tooling: ToolingConfig, options: SyncOptions, reservedBins: Set<string>, report?: ProgressReporter): Promise<{ changed: boolean; warnings: string[] }> {
	const venvDir = toolVenvDir(tooling, tool);
	const venvBinDir = toolVenvBinDir(venvDir);
	const pythonPath = join(venvBinDir, process.platform === "win32" ? "python.exe" : "python");
	const manifestPath = join(tooling.manifestDir, `${tool.name}.json`);
	const manifest = await readToolManifest(manifestPath);
	const fingerprint = toolFingerprint(tool, tooling);
	const fingerprintMatches = manifest?.fingerprint === fingerprint;
	const binsExist = tool.bins.every((bin) => existsSync(join(venvBinDir, bin)));
	const needsInstall = options.update || !existsSync(pythonPath) || !binsExist || !fingerprintMatches;
	if (needsInstall && !options.installMissing && !options.update) throw new Error("not installed or out of date; run /tools-sync");
	let changed = false;
	if (needsInstall) {
		report?.(`Tools: ${tool.name}: creating virtualenv...`, "info");
		await rm(venvDir, { recursive: true, force: true });
		await mkdir(dirname(venvDir), { recursive: true });
		const pythonCommand = tool.pythonCommand ?? tooling.pythonCommand;
		await execOrThrow(pi, pythonCommand[0]!, [...pythonCommand.slice(1), "-m", "venv", venvDir]);
		report?.(`Tools: ${tool.name}: upgrading pip...`, "info");
		await execOrThrow(pi, pythonPath, ["-m", "pip", "install", "--upgrade", "pip"]);
		var installResult = await installPythonPackage(pi, pythonPath, tool, report);
		changed = true;
	}
	for (const bin of tool.bins) {
		const executable = join(venvBinDir, bin);
		if (!existsSync(executable)) throw new Error(`configured bin was not found after install: ${executable}`);
	}
	await removeStaleShims(tooling, manifest, tool, reservedBins);
	for (const bin of tool.bins) await writeToolShim(tooling, venvDir, bin);
	if (changed || !fingerprintMatches) await writeToolManifest(manifestPath, { version: 1, name: tool.name, type: tool.type, packageSpec: tool.packageSpec, bins: tool.bins, venvDir, fingerprint, installedAt: new Date().toISOString() });
	return { changed, warnings: installResult?.warnings ?? [] };
}

async function installPythonPackage(pi: ExtensionAPI, pythonPath: string, tool: ToolConfig, report?: ProgressReporter): Promise<InstallResult> {
	const parsed = parseSimplePythonRequirement(tool.packageSpec);
	if (!parsed) {
		report?.(`Tools: ${tool.name}: installing ${tool.packageSpec}...`, "info");
		await execOrThrow(pi, pythonPath, ["-m", "pip", "install", "--upgrade", ...tool.installArgs, tool.packageSpec]);
		return { warnings: [] };
	}

	report?.(`Tools: ${tool.name}: installing ${tool.packageSpec}...`, "info");
	await execOrThrow(pi, pythonPath, ["-m", "pip", "install", "--upgrade", "--no-deps", ...tool.installArgs, tool.packageSpec]);
	const dependencies = await listInstalledPackageDependencies(pi, pythonPath, parsed.name, parsed.extras);
	const warnings: string[] = [];
	for (const dependency of dependencies) {
		report?.(`Tools: ${tool.name}: installing dependency ${dependency}...`, "info");
		const result = await pi.exec(pythonPath, ["-m", "pip", "install", "--upgrade", dependency], { timeout: COMMAND_TIMEOUT_MS });
		if (result.code !== 0) {
			const details = [result.stderr?.trim(), result.stdout?.trim()].filter(Boolean).join("\n");
			warnings.push(`skipped dependency ${JSON.stringify(dependency)} after install failure${details ? `:\n${details}` : ""}`);
		}
	}
	return { warnings };
}

function parseSimplePythonRequirement(packageSpec: string): { name: string; extras: string[] } | undefined {
	const match = /^\s*([A-Za-z0-9_.-]+)\s*(?:\[([^\]]+)\])?\s*(?:[<>=!~].*)?$/.exec(packageSpec);
	if (!match) return undefined;
	return { name: match[1]!, extras: (match[2] ?? "").split(",").map((extra) => extra.trim()).filter(Boolean) };
}

async function listInstalledPackageDependencies(pi: ExtensionAPI, pythonPath: string, packageName: string, extras: string[]): Promise<string[]> {
	const script = `
import json
from importlib import metadata
try:
    from pip._vendor.packaging.requirements import Requirement
except Exception:
    from packaging.requirements import Requirement
extras = ${JSON.stringify(extras)}
marker_contexts = extras or [""]
dist = metadata.distribution(${JSON.stringify(packageName)})
deps = []
seen = set()
for raw in dist.requires or []:
    req = Requirement(raw)
    if req.marker is not None and not any(req.marker.evaluate({"extra": extra}) for extra in marker_contexts):
        continue
    req.marker = None
    dependency = str(req)
    if dependency not in seen:
        seen.add(dependency)
        deps.append(dependency)
print(json.dumps(deps))
`;
	const result = await execOrThrow(pi, pythonPath, ["-c", script]);
	return JSON.parse(result.stdout.trim()) as string[];
}

async function readToolManifest(path: string): Promise<ToolManifest | undefined> { if (!existsSync(path)) return undefined; try { const manifest = JSON.parse(await readFile(path, "utf8")) as unknown; return isRecord(manifest) ? manifest : undefined; } catch { return undefined; } }
async function writeToolManifest(path: string, manifest: Record<string, unknown>) { await mkdir(dirname(path), { recursive: true }); await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`, "utf8"); }
async function removeStaleShims(tooling: ToolingConfig, manifest: ToolManifest | undefined, tool: ToolConfig, reservedBins: Set<string>) { if (!Array.isArray(manifest?.bins)) return; for (const bin of manifest.bins) { if (typeof bin !== "string" || !isSafeBinName(bin)) continue; if (tool.bins.includes(bin) || reservedBins.has(bin)) continue; await rm(join(tooling.binDir, bin), { force: true }); } }

async function writeToolShim(tooling: ToolingConfig, venvDir: string, bin: string) {
	const shimPath = join(tooling.binDir, bin);
	const executable = join(toolVenvBinDir(venvDir), bin);
	const content = `#!/usr/bin/env bash\nset -euo pipefail\n\n# Generated by the Pi tooling manager. Do not edit by hand.\nVENV=${shellQuote(venvDir)}\nEXECUTABLE=${shellQuote(executable)}\n\nunset PYTHONHOME PYTHONPATH\nexport VIRTUAL_ENV="$VENV"\nexport PATH="$VENV/bin:$PATH"\n\nexec "$EXECUTABLE" "$@"\n`;
	await mkdir(dirname(shimPath), { recursive: true });
	await writeFile(shimPath, content, "utf8");
	await chmod(shimPath, 0o755);
}

function toolFingerprint(tool: ToolConfig, tooling: ToolingConfig): string { return hash(JSON.stringify({ version: 1, type: tool.type, packageSpec: tool.packageSpec, bins: tool.bins, pythonCommand: tool.pythonCommand ?? tooling.pythonCommand, installArgs: tool.installArgs })); }
function toolVenvDir(tooling: ToolingConfig, tool: ToolConfig): string { return join(tooling.venvDir, tool.name); }
function toolVenvBinDir(venvDir: string): string { return join(venvDir, process.platform === "win32" ? "Scripts" : "bin"); }
function injectToolingPath(command: string, tooling: ToolingConfig): string { if (command.includes(TOOLING_BASH_MARKER)) return command; return `${TOOLING_BASH_MARKER}\nexport PI_TOOLING_ROOT=${shellQuote(tooling.rootDir)}\nexport PI_TOOL_BIN=${shellQuote(tooling.binDir)}\nexport PATH=${shellQuote(tooling.binDir)}:$PATH\nunset PYTHONHOME PYTHONPATH\n# pi-tooling end\n\n${command}`; }
function toolingPromptGuidance(config: RuntimeConfig): string | undefined { if (!config.tooling.injectPath) return undefined; const bins = [...new Set(config.tools.filter((tool) => !tool.disabled).flatMap((tool) => tool.bins))].sort(); if (bins.length === 0) return undefined; return ["Pi-managed command-line tools are available on PATH from the Pi tooling shim directory.", `Configured Pi-managed commands: ${bins.length > 30 ? `${bins.slice(0, 30).join(", ")}, ...` : bins.join(", ")}.`, "Use these commands directly when relevant.", "Do not install Python packages into the current project virtualenv for agent tooling.", "Do not run pip install for tool setup; use /tools-sync instead."].join("\n"); }
async function execOrThrow(pi: ExtensionAPI, command: string, args: string[]) { const result = await pi.exec(command, args, { timeout: COMMAND_TIMEOUT_MS }); if (result.code === 0) return result; const details = [result.stderr?.trim(), result.stdout?.trim()].filter(Boolean).join("\n"); throw new Error(`${command} ${args.join(" ")} failed with exit code ${result.code}${details ? `:\n${details}` : ""}`); }
function normalizeCommand(value: unknown, label: string, warnings: string[]): string[] | undefined { if (value === undefined) return undefined; if (typeof value === "string" && value.trim()) return [value.trim()]; if (Array.isArray(value) && value.every((item) => typeof item === "string")) { const command = value.map((item) => item.trim()).filter(Boolean); if (command.length > 0) return command; } warnings.push(`${label} must be a non-empty string or array of strings.`); return undefined; }
function normalizeStringList(value: unknown, label: string, warnings: string[]): string[] | undefined { if (value === undefined) return undefined; if (typeof value === "string") return [value]; if (Array.isArray(value) && value.every((item) => typeof item === "string")) return value; warnings.push(`${label} must be a string or array of strings when provided.`); return undefined; }
function dedupeTools(tools: ToolConfig[], warnings: string[]): ToolConfig[] { const byName = new Map<string, ToolConfig>(); for (const tool of tools) byName.set(tool.name, tool); const binOwners = new Map<string, string>(); const deduped: ToolConfig[] = []; for (const tool of byName.values()) { if (!tool.disabled) { const conflictingBin = tool.bins.find((bin) => binOwners.has(bin)); if (conflictingBin) { warnings.push(`${tool.origin}: tool ${JSON.stringify(tool.name)} skipped because bin ${JSON.stringify(conflictingBin)} conflicts with tool ${JSON.stringify(binOwners.get(conflictingBin))}.`); continue; } for (const bin of tool.bins) binOwners.set(bin, tool.name); } deduped.push(tool); } return deduped; }
function countEnabledTools(config: RuntimeConfig): number { return config.tools.filter((tool) => !tool.disabled).length; }
function getAgentDir(): string { return process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent"); }
function expandPath(path: string, baseDir = process.cwd()): string { let expanded = path; if (expanded === "~") expanded = homedir(); else if (expanded.startsWith("~/")) expanded = join(homedir(), expanded.slice(2)); return isAbsolute(expanded) ? expanded : resolve(baseDir, expanded); }
function displayPath(path: string): string { const home = homedir(); if (path === home) return "~"; const normalizedHome = home.endsWith(sep) ? home : `${home}${sep}`; return path.startsWith(normalizedHome) ? `~/${path.slice(normalizedHome.length)}` : path; }
function piToolNameForBin(bin: string): string { if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(bin) && !BUILT_IN_TOOL_NAMES.has(bin)) return bin; const sanitized = bin.replace(/[^A-Za-z0-9_]/g, "_").replace(/^[^A-Za-z_]+/, ""); return `pi_tool_${sanitized || hash(bin)}`; }
function splitArgs(args: string): string[] { return args.split(/\s+/).map((arg) => arg.trim()).filter(Boolean); }
function notifyWarnings(ctx: ExtensionContext | ExtensionCommandContext, warnings: string[], prefix = "Tools", report?: ProgressReporter) { if (warnings.length === 0) return; for (const warning of warnings) (report ?? ((message, level) => emitFeedback(ctx, message, level)))(`${prefix}: ${warning}`, "warning"); }
function emitFeedback(ctx: ExtensionContext | ExtensionCommandContext, message: string, level: FeedbackLevel = "info") { if (ctx.hasUI) { ctx.ui.notify(message, level); return; } const write = level === "error" ? console.error : level === "warning" ? console.warn : console.log; write(message); }
function formatFeedbackLine(message: string, level: FeedbackLevel): string { return level === "info" ? message : `[${level.toUpperCase()}] ${message}`; }
function sendCommandReport(pi: ExtensionAPI, command: string, lines: string[]) { pi.sendMessage({ customType: "pi-tooling", content: [`/${command} report`, "", ...(lines.length > 0 ? lines : ["(no output)"])].join("\n"), display: true }); }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function isSafeToolName(value: string): boolean { return value !== "." && value !== ".." && /^[A-Za-z0-9_.-]+$/.test(value); }
function isSafeBinName(value: string): boolean { return isSafeToolName(value); }
function shellQuote(value: string): string { return `'${value.replace(/'/g, "'\\''")}'`; }
function hash(value: string): string { return createHash("sha256").update(value).digest("hex").slice(0, 16); }
