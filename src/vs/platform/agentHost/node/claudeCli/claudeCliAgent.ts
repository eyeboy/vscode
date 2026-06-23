/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import { promises as fs } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { SequencerByKey } from '../../../../base/common/async.js';
import { CancellationError } from '../../../../base/common/errors.js';
import { Emitter } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { IObservable, observableValue } from '../../../../base/common/observable.js';
import { URI } from '../../../../base/common/uri.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { localize } from '../../../../nls.js';
import { ILogService } from '../../../log/common/log.js';
import { createSchema, platformSessionSchema, schemaProperty } from '../../common/agentHostSchema.js';
import { ClaudePermissionMode, ClaudeSessionConfigKey } from '../../common/claudeSessionConfigKeys.js';
import { claudeLocalAgentConfigSchema, ClaudeLocalAgentConfigKey, type IClaudeLocalAgentProfiles } from '../../common/claudeLocalAgentConfigSchema.js';
import { SessionConfigKey } from '../../common/sessionConfigKeys.js';
import {
	AgentProvider,
	AgentSession,
	AgentSignal,
	IAgent,
	IAgentCreateSessionConfig,
	IAgentCreateSessionResult,
	IAgentDescriptor,
	IAgentModelInfo,
	IAgentResolveSessionConfigParams,
	IAgentSessionConfigCompletionsParams,
	IAgentSessionMetadata,
} from '../../common/agentService.js';
import { IAgentConfigurationService } from '../agentConfigurationService.js';
import { ChatInputResponseKind, MessageKind, ResponsePartKind, TurnState, type ChatInputAnswer, type MessageAttachment, type ModelSelection, type PendingMessage, type ResponsePart, type ToolCallResult, type Turn, type UsageInfo } from '../../common/state/sessionState.js';
import { ActionType } from '../../common/state/sessionActions.js';
import type { ResolveSessionConfigResult, SessionConfigCompletionsResult } from '../../common/state/protocol/commands.js';
import type { AgentSelection, ClientPluginCustomization, Customization, ProtectedResourceMetadata, ToolDefinition } from '../../common/state/protocol/state.js';
import type { ISyncedCustomization } from '../../common/agentPluginManager.js';
import { mapClaudeCliLine, type IClaudeCliMapResult, type IClaudeCliMessage } from './claudeCliMapEvents.js';

/**
 * In-memory state for one Claude-CLI session. One entry per protocol
 * session id; created in {@link ClaudeCliAgent.createSession} and torn
 * down in {@link ClaudeCliAgent.disposeSession} / {@link ClaudeCliAgent.shutdown}.
 *
 * The CLI itself owns the real conversation transcript on disk (keyed by
 * the `session_id` it emits in its `system/init` line); we capture that
 * id lazily on the first turn so subsequent turns can `--resume` it.
 */
interface IClaudeCliSessionEntry {
	/** Resolved working directory (fsPath) forwarded to the CLI as `cwd`. */
	readonly workingDirectory: string | undefined;
	/** Model id to pass via `--model`; applied on the next turn. */
	model: string | undefined;
	/**
	 * `session_id` captured from the CLI's `system/init` line. Once set,
	 * subsequent turns pass `--resume <capturedSessionId>` so the CLI
	 * rehydrates its own conversation state.
	 */
	capturedSessionId: string | undefined;
	/** The spawned CLI child process for the in-flight turn, if any. */
	child: ChildProcessWithoutNullStreams | undefined;
	/** Rejects the in-flight turn's sendMessage promise on abort/close. */
	pendingTurnReject: ((e: Error) => void) | undefined;
	/** Resolves the in-flight turn's sendMessage promise on terminal result. */
	pendingTurnResolve: (() => void) | undefined;
	/** True once the in-flight turn has emitted its terminal `result` line. */
	turnSettled: boolean;
}

/**
 * Parsed shape of a single line in a Claude Code session transcript
 * (`~/.claude/projects/<encodedCwd>/<sessionId>.jsonl`). Only the fields
 * we read are declared; unknown fields are ignored. A line is one of:
 *  - `user` / `assistant` turn entries (carrying `message` + `timestamp`),
 *  - `summary` / `ai-title` metadata entries,
 *  - other noise types (`queue-operation`, `attachment`, `mode`, …) which
 *    we skip.
 */
interface IClaudeTranscriptLine {
	type: string;
	timestamp?: string;
	uuid?: string;
	/** Real working directory, present on many line types (e.g. `attachment`, `system/init`). */
	cwd?: string;
	message?: {
		role?: string;
		model?: string;
		content?: string | readonly IClaudeContentBlock[];
		usage?: {
			input_tokens?: number;
			output_tokens?: number;
			cache_read_input_tokens?: number;
		};
	};
	summary?: string;
	aiTitle?: string;
}

/** A content block within an assistant/user `message.content` array. */
interface IClaudeContentBlock {
	type: string; // 'text' | 'thinking' | 'tool_use' | 'tool_result' | …
	text?: string;
	thinking?: string;
}

/**
 * Max number of session files to scan in {@link ClaudeCliAgent.listSessions}.
 * The user's `~/.claude/projects/` tree can contain dozens of project dirs
 * with hundreds of session files; scanning every file end-to-end on each
 * call would make session enumeration sluggish. Instead we stat every file
 * for mtime, take the most-recently-modified N, and stream-scan only those
 * for metadata. The cap is intentionally generous for v1; raise if needed.
 */
const CLAUDE_LIST_SESSIONS_CAP = 50;

/**
 * First-party {@link IAgent} provider that wraps the locally-installed
 * `claude` CLI. Each turn spawns `claude -p <prompt> --output-format
 * stream-json --verbose` (plus `--resume` / `--model` /
 * `--dangerously-skip-permissions` as configured) and maps the CLI's
 * canonical stream-json lines to {@link AgentSignal}s.
 *
 * Unlike the in-process Claude SDK agent, this provider carries no
 * Copilot proxy / auth surface — the CLI uses your own Claude Code
 * credentials/config directly. Sessions are ephemeral to the agent
 * host: the CLI owns the on-disk transcript (keyed by the `session_id`
 * it emits), and we only keep enough in-memory state to drive one
 * turn at a time per session.
 *
 * Configuration is read from the hot-reloadable `claudeLocalAgent.*`
 * root config (pushed by the renderer via `RootConfigChanged` actions)
 * through {@link IAgentConfigurationService.getRootValue}, and refreshed
 * on every {@link IAgentConfigurationService.onDidRootConfigChange}:
 *  - {@link ClaudeLocalAgentConfigKey.ClaudePath} — CLI executable path
 *    (default: `'claude'`).
 *  - {@link ClaudeLocalAgentConfigKey.SkipPermissions} — pass
 *    `--dangerously-skip-permissions` (default: `true`).
 *  - {@link ClaudeLocalAgentConfigKey.ExtraArgs} — extra CLI args
 *    appended to every spawn (default: `[]`).
 *  - {@link ClaudeLocalAgentConfigKey.Profiles} — named profile bags
 *    of env vars (default: `{}`).
 *  - {@link ClaudeLocalAgentConfigKey.ActiveProfile} — which profile
 *    is active; its env overrides `process.env` on spawn (default: `''`).
 */
export class ClaudeCliAgent extends Disposable implements IAgent {
	readonly id: AgentProvider = 'claude-cli';

	private readonly _onDidSessionProgress = this._register(new Emitter<AgentSignal>());
	readonly onDidSessionProgress = this._onDidSessionProgress.event;

	private readonly _models = observableValue<readonly IAgentModelInfo[]>(this, []);
	readonly models: IObservable<readonly IAgentModelInfo[]> = this._models;

	private readonly _sessions = new Map<string, IClaudeCliSessionEntry>();

	/**
	 * Per-session-id serializer for {@link sendMessage}. Prevents two
	 * concurrent sends on the same session from racing the CLI spawn
	 * (the CLI is strictly one-process-per-turn; a second spawn while
	 * the first is still streaming would interleave stdout lines).
	 */
	private readonly _sessionSequencer = new SequencerByKey<string>();

	/**
	 * Hot-reloadable config fields. All five are repopulated by
	 * {@link _readConfigFromRootConfig} on construction and on every
	 * {@link IAgentConfigurationService.onDidRootConfigChange}. They are
	 * intentionally mutable (not `readonly`) so the reload path can
	 * overwrite them in place.
	 */
	private _claudePath: string = 'claude';
	private _skipPermissions: boolean = true;
	private _extraArgs: readonly string[] = [];
	private _profiles: IClaudeLocalAgentProfiles = {};
	private _activeProfile: string = '';
	/**
	 * Derived from {@link _profiles}[{@link _activeProfile}]. Empty when
	 * no profile is active. Spread into the spawn `env` so the active
	 * profile's env overrides `process.env` on the next turn.
	 */
	private _activeEnv: Record<string, string> = {};

	constructor(
		@ILogService private readonly _logService: ILogService,
		@IAgentConfigurationService private readonly _configurationService: IAgentConfigurationService,
	) {
		super();
		this._readConfigFromRootConfig();
		// Hot-reload: re-read config + rebuild models whenever the renderer
		// pushes a `RootConfigChanged` action. The `_models.set` inside
		// `_readConfigFromRootConfig` is observed by the `AgentSideEffects`
		// autorun (which reads `agent.models`), so it automatically
		// re-publishes `RootAgentsChanged` to the renderer — no manual
		// `_updateAgents` nudge needed.
		this._register(this._configurationService.onDidRootConfigChange(() => this._readConfigFromRootConfig()));
	}

	/**
	 * Re-reads all five `claudeLocalAgent.*` root-config keys via
	 * {@link IAgentConfigurationService.getRootValue}, updating the
	 * mutable config fields in place and rebuilding the model catalog.
	 * Called once in the constructor and on every root-config change.
	 *
	 * `getRootValue` returns `undefined` for missing or schema-invalid
	 * values; we keep the prior default in that case.
	 */
	private _readConfigFromRootConfig(): void {
		const claudePath = this._configurationService.getRootValue(claudeLocalAgentConfigSchema, ClaudeLocalAgentConfigKey.ClaudePath);
		if (typeof claudePath === 'string' && claudePath.length > 0) {
			this._claudePath = claudePath;
		} else {
			this._claudePath = 'claude';
		}

		const skipPermissions = this._configurationService.getRootValue(claudeLocalAgentConfigSchema, ClaudeLocalAgentConfigKey.SkipPermissions);
		if (typeof skipPermissions === 'boolean') {
			this._skipPermissions = skipPermissions;
		} else {
			this._skipPermissions = true;
		}

		const extraArgs = this._configurationService.getRootValue(claudeLocalAgentConfigSchema, ClaudeLocalAgentConfigKey.ExtraArgs);
		if (Array.isArray(extraArgs) && extraArgs.every(v => typeof v === 'string')) {
			this._extraArgs = extraArgs;
		} else {
			this._extraArgs = [];
		}

		const profiles = this._configurationService.getRootValue(claudeLocalAgentConfigSchema, ClaudeLocalAgentConfigKey.Profiles);
		if (profiles && typeof profiles === 'object' && !Array.isArray(profiles)) {
			this._profiles = profiles as IClaudeLocalAgentProfiles;
		} else {
			this._profiles = {};
		}

		const activeProfile = this._configurationService.getRootValue(claudeLocalAgentConfigSchema, ClaudeLocalAgentConfigKey.ActiveProfile);
		if (typeof activeProfile === 'string') {
			this._activeProfile = activeProfile;
		} else {
			this._activeProfile = '';
		}

		this._activeEnv = this._profiles[this._activeProfile]?.env ?? {};

		this._models.set(this._buildModelsFromConfig(), undefined);
		const profileDebug = Object.keys(this._profiles).map(k => `${k}:${Object.keys(this._profiles[k]?.env ?? {}).length}`).join(',');
		this._logService.info(`[ClaudeCli] Config loaded (claudePath=${this._claudePath}, skipPermissions=${this._skipPermissions}, extraArgs=${JSON.stringify(this._extraArgs)}, profiles=${Object.keys(this._profiles).length}, activeProfile=${this._activeProfile || '(none)'}, envKeys={${profileDebug}})`);
	}

	/**
	 * Build the model catalog from the active profile's env (falling back
	 * to `process.env` for backward compat when no profile is active).
	 * The CLI itself resolves `ANTHROPIC_MODEL` (or the per-alias
	 * `ANTHROPIC_DEFAULT_*` overrides) to decide which model a turn
	 * actually runs — so we surface those real model ids in the UI
	 * rather than the bare aliases (`sonnet`/`opus`/`haiku`), which
	 * would mislead when a gateway remaps them (e.g. DeepSeek maps all
	 * aliases to `deepseek-v4-flash`).
	 *
	 * The id we advertise is also what we pass to `claude --model <id>`,
	 * so when the user picks one in the UI it flows through unchanged.
	 *
	 * When multiple profiles exist, each OTHER profile's `ANTHROPIC_MODEL`
	 * (if set) is also listed so the user can switch profiles by picking
	 * that model in the picker — see {@link changeModel}.
	 */
	private _buildModelsFromConfig(): readonly IAgentModelInfo[] {
		// Build a model catalog that spans EVERY profile's models, so the UI
		// picker lets the user pick any profile × any model in that profile.
		// Each model entry's id is encoded as `<profile>::<modelId>` so
		// `changeModel` can recover which profile to switch to and which model
		// id to pass via `--model`. The displayed name is `<modelId> (<profile>)`.
		const profileNames = Object.keys(this._profiles);
		if (profileNames.length === 0) {
			// No profiles configured — fall back to process env / bare aliases.
			const envSource: Record<string, string | undefined> = Object.keys(this._activeEnv).length > 0
				? this._activeEnv
				: process.env;
			const ids = [envSource['ANTHROPIC_MODEL'], envSource['ANTHROPIC_DEFAULT_SONNET_MODEL'], envSource['ANTHROPIC_DEFAULT_OPUS_MODEL'], envSource['ANTHROPIC_DEFAULT_HAIKU_MODEL']]
				.filter((v): v is string => typeof v === 'string' && v.length > 0);
			const seen = new Set<string>();
			const unique = ids.filter(id => (seen.has(id) ? false : (seen.add(id), true)));
			if (unique.length === 0) {
				return [
					{ provider: 'claude-cli', id: 'sonnet', name: 'Sonnet', supportsVision: true },
					{ provider: 'claude-cli', id: 'opus', name: 'Opus', supportsVision: true },
					{ provider: 'claude-cli', id: 'haiku', name: 'Haiku', supportsVision: true },
				];
			}
			return unique.map(id => ({ provider: 'claude-cli', id, name: id, supportsVision: true }));
		}

		const models: IAgentModelInfo[] = [];
		const seenIds = new Set<string>();
		// Active profile first (so its models sort to the top of the picker).
		const ordered = [this._activeProfile, ...profileNames.filter(p => p !== this._activeProfile)];
		for (const profileName of ordered) {
			if (!profileName) { continue; }
			const env = this._profiles[profileName]?.env;
			if (!env) { continue; }
			const ids = [env['ANTHROPIC_MODEL'], env['ANTHROPIC_DEFAULT_SONNET_MODEL'], env['ANTHROPIC_DEFAULT_OPUS_MODEL'], env['ANTHROPIC_DEFAULT_HAIKU_MODEL']]
				.filter((v): v is string => typeof v === 'string' && v.length > 0);
			for (const modelId of ids) {
				const id = `${profileName}::${modelId}`;
				if (seenIds.has(id)) { continue; }
				seenIds.add(id);
				models.push({ provider: 'claude-cli', id, name: `${modelId} (${profileName})`, supportsVision: true });
			}
		}
		return models;
	}

	// #region Descriptor + auth

	getDescriptor(): IAgentDescriptor {
		return {
			provider: this.id,
			displayName: localize('claudeCliAgent.displayName', "Claude (Local CLI)"),
			description: localize('claudeCliAgent.description', "Runs the locally-installed claude CLI with your own Claude Code credentials."),
		};
	}

	getProtectedResources(): ProtectedResourceMetadata[] {
		// The CLI uses its own auth (Claude Code credentials); no
		// RFC 9728 protected-resource metadata to advertise.
		return [];
	}

	authenticate(_resource: string, _token: string): Promise<boolean> {
		// No-op; the CLI manages its own authentication.
		return Promise.resolve(true);
	}

	// #endregion

	// #region Session lifecycle

	async createSession(config: IAgentCreateSessionConfig = {}): Promise<IAgentCreateSessionResult> {
		const sessionId = config.session ? AgentSession.id(config.session) : generateUuid();
		const sessionUri = AgentSession.uri(this.id, sessionId);
		if (this._sessions.has(sessionId)) {
			return {
				session: sessionUri,
				workingDirectory: config.workingDirectory,
				provisional: true,
			};
		}
		const entry: IClaudeCliSessionEntry = {
			workingDirectory: config.workingDirectory?.fsPath,
			model: config.model?.id,
			capturedSessionId: undefined,
			child: undefined,
			pendingTurnReject: undefined,
			pendingTurnResolve: undefined,
			turnSettled: false,
		};
		this._sessions.set(sessionId, entry);
		return {
			session: sessionUri,
			workingDirectory: config.workingDirectory,
			provisional: true,
		};
	}

	resolveSessionConfig(_params: IAgentResolveSessionConfigParams): Promise<ResolveSessionConfigResult> {
		// Mirror Claude's schema surface: a single `permissionMode` enum
		// (reusing the Claude permission-mode values) plus the platform
		// `Permissions` allow/deny list. v1 does not wire permissionMode
		// through to the CLI beyond the boolean skipPermissions flag —
		// the schema is advertised so the workbench renders a familiar
		// config surface.
		const sessionSchema = createSchema({
			[ClaudeSessionConfigKey.PermissionMode]: schemaProperty<ClaudePermissionMode>({
				type: 'string',
				title: localize('claudeCli.sessionConfig.permissionMode', "Approvals"),
				description: localize('claudeCli.sessionConfig.permissionModeDescription', "How the Claude CLI handles tool approvals."),
				enum: ['default', 'acceptEdits', 'plan', 'bypassPermissions'],
				enumLabels: [
					localize('claudeCli.sessionConfig.permissionMode.default', "Ask Before Edits"),
					localize('claudeCli.sessionConfig.permissionMode.acceptEdits', "Edit Automatically"),
					localize('claudeCli.sessionConfig.permissionMode.plan', "Plan Mode"),
					localize('claudeCli.sessionConfig.permissionMode.bypassPermissions', "Bypass Permissions"),
				],
				enumDescriptions: [
					localize('claudeCli.sessionConfig.permissionMode.defaultDescription', "Claude asks before editing files."),
					localize('claudeCli.sessionConfig.permissionMode.acceptEditsDescription', "Claude edits files without asking, and asks before using other tools."),
					localize('claudeCli.sessionConfig.permissionMode.planDescription', "Claude creates a plan before making changes."),
					localize('claudeCli.sessionConfig.permissionMode.bypassPermissionsDescription', "Claude runs all tools without asking."),
				],
				default: 'default',
				sessionMutable: true,
			}),
			[SessionConfigKey.Permissions]: platformSessionSchema.definition[SessionConfigKey.Permissions],
		});

		const values = sessionSchema.validateOrDefault(_params.config, {
			[ClaudeSessionConfigKey.PermissionMode]: 'default' satisfies ClaudePermissionMode,
		});

		return Promise.resolve({
			schema: sessionSchema.toProtocol(),
			values,
		});
	}

	sessionConfigCompletions(_params: IAgentSessionConfigCompletionsParams): Promise<SessionConfigCompletionsResult> {
		return Promise.resolve({ items: [] });
	}

	async listSessions(): Promise<IAgentSessionMetadata[]> {
		try {
			this._logService.info('[ClaudeCli] listSessions called');
			const projectsDir = this._claudeProjectsDir();
			let projectDirs: string[];
			try {
				const entries = await fs.readdir(projectsDir, { withFileTypes: true });
				projectDirs = entries
					.filter(e => e.isDirectory())
					.map(e => join(projectsDir, e.name));
			} catch {
				// No projects dir yet (fresh install) — nothing to enumerate.
				return [];
			}

			// Collect every `<sessionId>.jsonl` across all project dirs,
			// stat each for mtime, then keep the most-recently-modified N
			// (see CLAUDE_LIST_SESSIONS_CAP) so enumeration stays snappy.
			const candidates: { filePath: string; encodedCwd: string; mtimeMs: number }[] = [];
			for (const dir of projectDirs) {
				let files: string[];
				try {
					files = await fs.readdir(dir);
				} catch {
					continue;
				}
				for (const file of files) {
					if (!file.endsWith('.jsonl')) {
						continue;
					}
					const filePath = join(dir, file);
					try {
						const stat = await fs.stat(filePath);
						if (!stat.isFile()) {
							continue;
						}
						candidates.push({ filePath, encodedCwd: dir.split('/').pop() ?? '', mtimeMs: stat.mtimeMs });
					} catch {
						// Stat failed (race / permissions) — skip this file.
					}
				}
			}
			candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
			const selected = candidates.slice(0, CLAUDE_LIST_SESSIONS_CAP);
			this._logService.info(`[ClaudeCli] listSessions: ${candidates.length} total session files, scanning top ${selected.length}`);

			const metadata: IAgentSessionMetadata[] = [];
			for (const candidate of selected) {
				const meta = await this._readSessionMetadata(candidate.filePath, candidate.encodedCwd);
				if (meta) {
					metadata.push(meta);
				}
			}
			// Re-sort by modifiedTime desc (scanned metadata may refine mtime
			// from the transcript's own timestamps; the file mtime was only a
			// selection heuristic).
			metadata.sort((a, b) => b.modifiedTime - a.modifiedTime);
			this._logService.info(`[ClaudeCli] listSessions returning ${metadata.length} sessions`);
			return metadata;
		} catch (err) {
			this._logService.warn('[ClaudeCli] listSessions failed', err);
			return [];
		}
	}

	async getSessionMessages(session: URI): Promise<readonly Turn[]> {
		try {
			const sessionId = AgentSession.id(session);
			const filePath = await this._findSessionFile(sessionId);
			if (!filePath) {
				return [];
			}
			const turns = await this._readSessionTurns(filePath);
			return turns;
		} catch (err) {
			this._logService.warn(`[ClaudeCli] getSessionMessages failed for ${session.toString()}`, err);
			return [];
		}
	}

	async disposeSession(session: URI): Promise<void> {
		const sessionId = AgentSession.id(session);
		const entry = this._sessions.get(sessionId);
		if (entry) {
			this._killChild(entry);
			this._sessions.delete(sessionId);
		}
	}

	// #endregion

	// #region Claude Code transcript helpers (listSessions / getSessionMessages)

	/**
	 * Returns the `~/.claude/projects` directory. Uses `process.env.HOME`
	 * when set (preferred — respects a overridden home), falling back to
	 * `os.homedir()`.
	 */
	private _claudeProjectsDir(): string {
		const home = process.env.HOME || homedir();
		return join(home, '.claude', 'projects');
	}

	/**
	 * Decodes a Claude Code encoded-cwd directory name back to a filesystem
	 * path. The encoding replaces every `/` in the path with `-` (so
	 * `/Users/wangxin/foo` → `-Users-wangxin-foo`). Decoding is inherently
	 * ambiguous if a path segment contains `-`; this is acceptable for the
	 * display-only `workingDirectory` field. The inverse: replace the
	 * leading `-` with `/`, then every remaining `-` with `/`.
	 */
	private _decodeEncodedCwd(encodedCwd: string): string {
		if (encodedCwd.length === 0) {
			return '';
		}
		// Leading '-' is the root '/'.
		const withoutLeading = encodedCwd.startsWith('-') ? encodedCwd.slice(1) : encodedCwd;
		return '/' + withoutLeading.replace(/-/g, '/');
	}

	/**
	 * Streams a jsonl transcript file line-by-line, invoking `onLine` for
	 * each non-empty line. Resolves when the file is fully consumed.
	 * Throws on read error (caller handles). Uses `fs.createReadStream`
	 * so large transcripts are not held in memory at once.
	 */
	private async _streamJsonl(filePath: string, onLine: (line: string) => void): Promise<void> {
		let handle: fs.FileHandle | undefined;
		try {
			handle = await fs.open(filePath, 'r');
			const stream = handle.createReadStream({ encoding: 'utf8' });
			let buffer = '';
			for await (const chunk of stream) {
				buffer += chunk as string;
				let newlineIndex: number;
				while ((newlineIndex = buffer.indexOf('\n')) >= 0) {
					const line = buffer.slice(0, newlineIndex);
					buffer = buffer.slice(newlineIndex + 1);
					if (line.length === 0 || line.trim().length === 0) {
						continue;
					}
					onLine(line);
				}
			}
			if (buffer.trim().length > 0) {
				onLine(buffer);
			}
		} finally {
			await handle?.close().catch(() => { });
		}
	}

	/**
	 * Reads metadata for a single session transcript file in one streaming
	 * pass: collects the earliest/latest `timestamp`, the last `summary`
	 * (falling back to `ai-title`), and the last assistant line's model.
	 * Returns `undefined` if the file is empty / unparseable / has no
	 * usable timestamps.
	 */
	private async _readSessionMetadata(filePath: string, encodedCwd: string): Promise<IAgentSessionMetadata | undefined> {
		let firstMs: number | undefined;
		let lastMs: number | undefined;
		let summary: string | undefined;
		let aiTitle: string | undefined;
		let lastModel: string | undefined;
		let cwd: string | undefined;

		try {
			await this._streamJsonl(filePath, (line) => {
				let parsed: IClaudeTranscriptLine;
				try {
					parsed = JSON.parse(line) as IClaudeTranscriptLine;
				} catch {
					return; // skip unparseable line
				}
				if (parsed.timestamp) {
					const ms = Date.parse(parsed.timestamp);
					if (!Number.isNaN(ms)) {
						if (firstMs === undefined || ms < firstMs) {
							firstMs = ms;
						}
						if (lastMs === undefined || ms > lastMs) {
							lastMs = ms;
						}
					}
				}
				// Capture the real working directory from the transcript (the
				// `cwd` field is unambiguous, unlike decoding the encoded dir
				// name where `-` collides with path separators). Take the first
				// one seen — it's the session's root cwd.
				if (!cwd && typeof parsed.cwd === 'string' && parsed.cwd.length > 0) {
					cwd = parsed.cwd;
				}
				if (parsed.type === 'summary' && typeof parsed.summary === 'string' && parsed.summary.length > 0) {
					summary = parsed.summary;
				} else if (parsed.type === 'ai-title' && typeof parsed.aiTitle === 'string' && parsed.aiTitle.length > 0) {
					aiTitle = parsed.aiTitle;
				} else if (parsed.type === 'assistant' && typeof parsed.message?.model === 'string') {
					// Track the most recent assistant model; ignore the
					// synthetic placeholder the CLI emits on auth failure.
					const model = parsed.message.model;
					if (model !== '<synthetic>') {
						lastModel = model;
					}
				}
			});
		} catch (err) {
			this._logService.warn(`[ClaudeCli] failed to read session metadata: ${filePath}`, err);
			return undefined;
		}

		if (firstMs === undefined || lastMs === undefined) {
			// No timestamped lines — not a usable session transcript.
			return undefined;
		}

		const sessionId = filePath.split('/').pop()?.replace(/\.jsonl$/, '');
		if (!sessionId) {
			return undefined;
		}

		// Prefer the real `cwd` from the transcript; fall back to decoding the
		// encoded dir name (lossy — `-` ambiguity) only if no cwd was recorded.
		const workingDirectory = cwd ? URI.file(cwd) : URI.file(this._decodeEncodedCwd(encodedCwd));

		const meta: IAgentSessionMetadata = {
			session: AgentSession.uri(this.id, sessionId),
			startTime: firstMs,
			modifiedTime: lastMs,
			summary: summary ?? aiTitle,
			workingDirectory,
			...(lastModel ? { model: { id: lastModel } satisfies ModelSelection } : {}),
		};
		return meta;
	}

	/**
	 * Locates the `<sessionId>.jsonl` transcript file by scanning all
	 * project dirs under `~/.claude/projects/`. Returns `undefined` if
	 * not found.
	 */
	private async _findSessionFile(sessionId: string): Promise<string | undefined> {
		const projectsDir = this._claudeProjectsDir();
		let projectDirs: string[];
		try {
			const entries = await fs.readdir(projectsDir, { withFileTypes: true });
			projectDirs = entries
				.filter(e => e.isDirectory())
				.map(e => join(projectsDir, e.name));
		} catch {
			return undefined;
		}
		const target = `${sessionId}.jsonl`;
		for (const dir of projectDirs) {
			const candidate = join(dir, target);
			try {
				const stat = await fs.stat(candidate);
				if (stat.isFile()) {
					return candidate;
				}
			} catch {
				// not present in this dir — keep scanning
			}
		}
		return undefined;
	}

	/**
	 * Reconstructs the {@link Turn} history from a session transcript.
	 * A turn = one user prompt + all following assistant messages until
	 * the next user prompt. User messages that are tool-result echoes
	 * (content array with only `tool_result` blocks) are NOT real prompts
	 * and are skipped. Tool-use blocks are omitted from `responseParts`
	 * for v1 (would require full ToolCallState); only text and thinking
	 * blocks are emitted as Markdown / Reasoning parts.
	 */
	private async _readSessionTurns(filePath: string): Promise<Turn[]> {
		// Collect the ordered sequence of user/assistant lines. We need
		// the full sequence to group assistant messages under their
		// preceding user prompt; a single streaming pass into an array is
		// the simplest correct shape. Transcripts are bounded by turn
		// count, so holding them in memory is acceptable for v1.
		const sequence: IClaudeTranscriptLine[] = [];
		await this._streamJsonl(filePath, (line) => {
			let parsed: IClaudeTranscriptLine;
			try {
				parsed = JSON.parse(line) as IClaudeTranscriptLine;
			} catch {
				return;
			}
			if (parsed.type === 'user' || parsed.type === 'assistant') {
				sequence.push(parsed);
			}
			// Other line types (queue-operation, attachment, mode, …) ignored.
		});

		// Walk the sequence: each `user` line opens a turn; subsequent
		// `assistant` lines (until the next `user` line) are its response.
		const turns: Turn[] = [];
		let currentUser: IClaudeTranscriptLine | undefined;
		let currentAssistants: IClaudeTranscriptLine[] = [];

		const flush = () => {
			if (currentUser && currentAssistants.length > 0) {
				const turn = this._buildTurn(currentUser, currentAssistants);
				if (turn) {
					turns.push(turn);
				}
			}
			currentUser = undefined;
			currentAssistants = [];
		};

		for (const entry of sequence) {
			if (entry.type === 'user') {
				flush();
				currentUser = entry;
			} else if (entry.type === 'assistant') {
				if (currentUser) {
					currentAssistants.push(entry);
				}
			}
		}
		flush();

		return turns;
	}

	/**
	 * Builds a single {@link Turn} from one user prompt line and its
	 * associated assistant response lines. Returns `undefined` if the
	 * user message is a tool-result echo (no real prompt text) or if no
	 * response parts can be derived.
	 */
	private _buildTurn(userLine: IClaudeTranscriptLine, assistantLines: readonly IClaudeTranscriptLine[]): Turn | undefined {
		const userText = this._extractUserText(userLine);
		if (userText === undefined) {
			// Tool-result-only user message — not a real prompt; skip.
			return undefined;
		}
		const turnId = userLine.uuid ?? generateUuid();

		const responseParts: ResponsePart[] = [];
		let blockIndex = 0;
		let inputTokens = 0;
		let outputTokens = 0;
		let cacheReadTokens = 0;
		let model: string | undefined;
		let hasUsage = false;

		for (const assistant of assistantLines) {
			const content = assistant.message?.content;
			if (!Array.isArray(content)) {
				continue;
			}
			for (const block of content) {
				if (block.type === 'text' && typeof block.text === 'string') {
					responseParts.push({
						kind: ResponsePartKind.Markdown,
						id: `${turnId}#${blockIndex}`,
						content: block.text,
					});
					blockIndex++;
				} else if (block.type === 'thinking' && typeof block.thinking === 'string') {
					responseParts.push({
						kind: ResponsePartKind.Reasoning,
						id: `${turnId}#${blockIndex}`,
						content: block.thinking,
					});
					blockIndex++;
				}
				// tool_use blocks are intentionally skipped for v1.
			}
			const usage = assistant.message?.usage;
			if (usage) {
				if (typeof usage.input_tokens === 'number') {
					inputTokens += usage.input_tokens;
					hasUsage = true;
				}
				if (typeof usage.output_tokens === 'number') {
					outputTokens += usage.output_tokens;
					hasUsage = true;
				}
				if (typeof usage.cache_read_input_tokens === 'number') {
					cacheReadTokens += usage.cache_read_input_tokens;
					hasUsage = true;
				}
			}
			const assistantModel = assistant.message?.model;
			if (typeof assistantModel === 'string' && assistantModel !== '<synthetic>') {
				model = assistantModel;
			}
		}

		if (responseParts.length === 0) {
			// No displayable assistant content — skip this turn.
			return undefined;
		}

		let usage: UsageInfo | undefined;
		if (hasUsage) {
			usage = {
				inputTokens: inputTokens,
				outputTokens: outputTokens,
				cacheReadTokens: cacheReadTokens,
			};
			if (model) {
				usage.model = model;
			}
		}

		return {
			id: turnId,
			message: {
				text: userText,
				origin: { kind: MessageKind.User },
			},
			responseParts,
			usage,
			state: TurnState.Complete,
		};
	}

	/**
	 * Extracts the user prompt text from a `user` transcript line.
	 * - If `message.content` is a string, returns it.
	 * - If it's an array, concatenates `text` blocks; returns `undefined`
	 *   when the array contains only `tool_result` blocks (a tool-result
	 *   echo, not a real user prompt) so the caller can skip the turn.
	 * - Returns `''` for an empty-but-real prompt so it is still emitted.
	 */
	private _extractUserText(userLine: IClaudeTranscriptLine): string | undefined {
		const content = userLine.message?.content;
		if (typeof content === 'string') {
			return content;
		}
		if (!Array.isArray(content)) {
			return undefined;
		}
		const textParts: string[] = [];
		let hasToolResult = false;
		for (const block of content) {
			if (block.type === 'text' && typeof block.text === 'string') {
				textParts.push(block.text);
			} else if (block.type === 'tool_result') {
				hasToolResult = true;
			}
		}
		if (textParts.length > 0) {
			return textParts.join('\n');
		}
		// Array with no text blocks: if it had tool_result blocks it's a
		// tool-result echo (skip); otherwise treat as an empty prompt.
		return hasToolResult ? undefined : '';
	}

	// #endregion

	// #region Send / abort / model

	async sendMessage(sessionUri: URI, prompt: string, _attachments?: readonly MessageAttachment[], turnId?: string): Promise<void> {
		const sessionId = AgentSession.id(sessionUri);
		const effectiveTurnId = turnId ?? generateUuid();
		return this._sessionSequencer.queue(sessionId, async () => {
			let entry = this._sessions.get(sessionId);
			if (!entry) {
				// The session came from the persisted catalog (listSessions)
				// without a prior createSession in this process — e.g. the user
				// clicked a historical session in the Agents window sidebar and
				// sent a follow-up message. Lazily materialize an in-memory
				// entry backed by the on-disk transcript so the next turn
				// `--resume`s the real claude session_id.
				entry = await this._materializePersistedSession(sessionId);
				if (!entry) {
					throw new Error(`[ClaudeCli] sendMessage: unknown session ${sessionId}`);
				}
			}
			await this._runTurn(sessionUri, sessionId, entry, prompt, effectiveTurnId);
		});
	}

	/**
	 * Build an in-memory {@link IClaudeCliSessionEntry} for a session that
	 * exists on disk (from `listSessions`) but was never created in this
	 * process. Reads the transcript to recover the working directory and
	 * sets `capturedSessionId` to the session id so the next turn resumes it.
	 * Returns undefined if no transcript file exists for the id.
	 */
	private async _materializePersistedSession(sessionId: string): Promise<IClaudeCliSessionEntry | undefined> {
		const filePath = await this._findSessionFile(sessionId);
		if (!filePath) {
			return undefined;
		}
		// Read just enough of the transcript to recover the cwd (the real
		// working directory). The encoded dir name is lossy, so prefer the
		// `cwd` field on any line that carries it.
		let cwd: string | undefined;
		try {
			await this._streamJsonl(filePath, (line) => {
				if (cwd) {
					return; // got it — stop caring
				}
				try {
					const parsed = JSON.parse(line) as IClaudeTranscriptLine;
					if (typeof parsed.cwd === 'string' && parsed.cwd.length > 0) {
						cwd = parsed.cwd;
					}
				} catch {
					// skip unparseable line
				}
			});
		} catch (err) {
			this._logService.warn(`[ClaudeCli] failed to read transcript for resume ${sessionId}`, err);
		}
		const entry: IClaudeCliSessionEntry = {
			workingDirectory: cwd,
			model: undefined,
			// The on-disk transcript is keyed by the claude session_id, which
			// equals our sessionId. `--resume <sessionId>` rehydrates it.
			capturedSessionId: sessionId,
			child: undefined,
			pendingTurnReject: undefined,
			pendingTurnResolve: undefined,
			turnSettled: false,
		};
		this._sessions.set(sessionId, entry);
		return entry;
	}

	/**
	 * Spawn the CLI for one turn, read its stdout line-by-line, map each
	 * parsed JSON line to {@link AgentSignal}s, and resolve once the
	 * terminal `result` line has been processed (or reject on error /
	 * early close / abort).
	 */
	private _runTurn(
		sessionUri: URI,
		sessionId: string,
		entry: IClaudeCliSessionEntry,
		prompt: string,
		turnId: string,
	): Promise<void> {
		return new Promise<void>((resolve, reject) => {
			const args: string[] = ['-p', prompt, '--output-format', 'stream-json', '--verbose'];
			if (entry.capturedSessionId) {
				args.push('--resume', entry.capturedSessionId);
			}
			if (entry.model) {
				args.push('--model', entry.model);
			}
			if (this._skipPermissions) {
				args.push('--dangerously-skip-permissions');
			}
			args.push(...this._extraArgs);

			entry.turnSettled = false;
			entry.pendingTurnResolve = () => {
				entry.pendingTurnResolve = undefined;
				entry.pendingTurnReject = undefined;
				resolve();
			};
			entry.pendingTurnReject = (err: Error) => {
				entry.pendingTurnResolve = undefined;
				entry.pendingTurnReject = undefined;
				reject(err);
			};

			let child: ChildProcessWithoutNullStreams;
			try {
				child = spawn(this._claudePath, args, {
					cwd: entry.workingDirectory,
					env: { ...process.env, ...this._activeEnv },
					shell: false,
				});
			} catch (err) {
				entry.pendingTurnReject?.(err instanceof Error ? err : new Error(String(err)));
				return;
			}
			entry.child = child;

			let stdoutBuffer = '';
			child.stdout.setEncoding('utf8');
			child.stdout.on('data', (chunk: string) => {
				stdoutBuffer += chunk;
				let newlineIndex: number;
				while ((newlineIndex = stdoutBuffer.indexOf('\n')) >= 0) {
					const line = stdoutBuffer.slice(0, newlineIndex);
					stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
					if (line.trim().length === 0) {
						continue;
					}
					this._processCliLine(line, sessionUri, sessionId, entry, turnId);
				}
			});

			let stderrBuffer = '';
			child.stderr.setEncoding('utf8');
			child.stderr.on('data', (chunk: string) => {
				stderrBuffer += chunk;
				let newlineIndex: number;
				while ((newlineIndex = stderrBuffer.indexOf('\n')) >= 0) {
					const line = stderrBuffer.slice(0, newlineIndex);
					stderrBuffer = stderrBuffer.slice(newlineIndex + 1);
					if (line.trim().length === 0) {
						continue;
					}
					// stderr is progress/noise (e.g. hook output); log but
					// do not surface as chat content.
					this._logService.info(`[ClaudeCli:${sessionId}] stderr: ${line}`);
				}
			});

			child.on('error', err => {
				this._logService.error(`[ClaudeCli:${sessionId}] child error`, err);
				if (!entry.turnSettled) {
					this._emitErrorAndComplete(sessionUri, turnId, 'spawn_error', err.message);
					entry.pendingTurnReject?.(err);
				}
			});

			child.on('close', code => {
				entry.child = undefined;
				if (entry.turnSettled) {
					return;
				}
				// Closed before the terminal `result` line arrived.
				this._logService.warn(`[ClaudeCli:${sessionId}] child closed (code=${code}) before result line`);
				const message = `claude CLI exited (code ${code}) before producing a result`;
				this._emitErrorAndComplete(sessionUri, turnId, 'premature_close', message);
				entry.pendingTurnReject?.(new Error(message));
			});
		});
	}

	private _processCliLine(
		line: string,
		sessionUri: URI,
		sessionId: string,
		entry: IClaudeCliSessionEntry,
		turnId: string,
	): void {
		let parsed: IClaudeCliMessage;
		try {
			parsed = JSON.parse(line) as IClaudeCliMessage;
		} catch (err) {
			this._logService.warn(`[ClaudeCli:${sessionId}] failed to parse stdout line: ${line.slice(0, 200)}`, err);
			return;
		}

		let result: IClaudeCliMapResult;
		try {
			result = mapClaudeCliLine(parsed, sessionUri, turnId);
		} catch (err) {
			this._logService.error(`[ClaudeCli:${sessionId}] mapper threw for line: ${line.slice(0, 200)}`, err);
			return;
		}

		if (result.capturedSessionId && !entry.capturedSessionId) {
			entry.capturedSessionId = result.capturedSessionId;
		}

		for (const signal of result.signals) {
			this._onDidSessionProgress.fire(signal);
		}

		// A terminal `result` line ends the turn.
		if (parsed.type === 'result') {
			entry.turnSettled = true;
			entry.pendingTurnResolve?.();
		}
	}

	private _emitErrorAndComplete(sessionUri: URI, turnId: string, errorType: string, message: string): void {
		this._onDidSessionProgress.fire({
			kind: 'action',
			session: sessionUri,
			action: {
				type: ActionType.ChatError,
				turnId,
				error: { errorType, message },
			},
		});
		this._onDidSessionProgress.fire({
			kind: 'action',
			session: sessionUri,
			action: {
				type: ActionType.ChatTurnComplete,
				turnId,
			},
		});
	}

	async abortSession(session: URI): Promise<void> {
		// Abort is a control-plane op: do NOT go through the send
		// sequencer (an in-flight sendMessage is parked on its turn
		// promise and would deadlock behind the very turn it cancels).
		const sessionId = AgentSession.id(session);
		const entry = this._sessions.get(sessionId);
		if (!entry) {
			return;
		}
		this._killChild(entry);
		const reject = entry.pendingTurnReject;
		entry.pendingTurnResolve = undefined;
		entry.pendingTurnReject = undefined;
		if (reject) {
			reject(new CancellationError());
		}
	}

	async changeModel(session: URI, model: ModelSelection): Promise<void> {
		const sessionId = AgentSession.id(session);
		const entry = this._sessions.get(sessionId);

		// Model ids from the picker are encoded as `<profile>::<modelId>`
		// (see _buildModelsFromConfig). Parse out the profile to switch to
		// and the concrete model id to pass via `--model`.
		const sepIdx = model.id.indexOf('::');
		if (sepIdx > 0) {
			const profileName = model.id.slice(0, sepIdx);
			const modelId = model.id.slice(sepIdx + 2);
			if (profileName !== this._activeProfile) {
				this._logService.info(`[ClaudeCli] Switching active profile '${this._activeProfile || '(none)'}' -> '${profileName}' (model=${modelId})`);
				this._activeProfile = profileName;
				this._activeEnv = this._profiles[profileName]?.env ?? {};
				this._models.set(this._buildModelsFromConfig(), undefined);
			}
			// If the picked model is the profile's ANTHROPIC_MODEL (primary),
			// no `--model` override is needed — the profile env already sets it.
			// Otherwise pass `--model <modelId>` to override the alias mapping.
			const primary = this._profiles[profileName]?.env?.['ANTHROPIC_MODEL'];
			if (entry) {
				entry.model = (modelId === primary) ? undefined : modelId;
			}
			return;
		}

		// Legacy bare-alias id (no `::`) — treat as a per-session override.
		if (entry) {
			entry.model = model.id;
		}
	}

	private _killChild(entry: IClaudeCliSessionEntry): void {
		const child = entry.child;
		if (child) {
			entry.child = undefined;
			try {
				if (!child.killed) {
					child.kill('SIGTERM');
				}
			} catch (err) {
				this._logService.warn('[ClaudeCli] failed to kill child process', err);
			}
		}
	}

	// #endregion

	// #region Client tools / customizations / permissions (no-ops for v1)

	setClientTools(_session: URI, _clientId: string | undefined, _tools: ToolDefinition[]): void {
		// v1: the CLI owns its own tool surface; client-provided tools
		// are not forwarded. Intentionally a no-op.
	}

	onClientToolCallComplete(_session: URI, _toolCallId: string, _result: ToolCallResult): void {
		// v1: no client-provided tools, so nothing to complete.
	}

	async setClientCustomizations(_session: URI, _clientId: string, _customizations: ClientPluginCustomization[]): Promise<ISyncedCustomization[]> {
		// v1: no host-side customization sync for the CLI provider.
		return [];
	}

	setCustomizationEnabled(_id: string, _enabled: boolean): void {
		// v1: no customization enablement surface.
	}

	getCustomizations(): readonly Customization[] {
		return [];
	}

	async getSessionCustomizations(_session: URI): Promise<readonly Customization[]> {
		return [];
	}

	setPendingMessages(_session: URI, _steeringMessage: PendingMessage | undefined, _queuedMessages: readonly PendingMessage[]): void {
		// v1: no steering/queue injection — the CLI is one-process-per-turn.
	}

	async changeAgent(_session: URI, _agent: AgentSelection | undefined): Promise<void> {
		// v1: no custom-agent selection for the CLI provider.
	}

	respondToPermissionRequest(_requestId: string, _approved: boolean): void {
		// v1: the CLI manages its own permission flow (skipPermissions /
		// interactive prompts); no host-mediated approvals.
	}

	respondToUserInputRequest(_requestId: string, _response: ChatInputResponseKind, _answers?: Record<string, ChatInputAnswer>): void {
		// v1: no host-mediated user-input elicitation.
	}

	// #endregion

	// #region Shutdown / dispose

	shutdown(): Promise<void> {
		for (const entry of this._sessions.values()) {
			this._killChild(entry);
			const reject = entry.pendingTurnReject;
			entry.pendingTurnResolve = undefined;
			entry.pendingTurnReject = undefined;
			reject?.(new CancellationError());
		}
		this._sessions.clear();
		return Promise.resolve();
	}

	override dispose(): void {
		for (const entry of this._sessions.values()) {
			this._killChild(entry);
		}
		this._sessions.clear();
		super.dispose();
	}

	// #endregion
}
