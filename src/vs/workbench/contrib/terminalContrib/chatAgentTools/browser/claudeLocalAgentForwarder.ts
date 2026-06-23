/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, IDisposable } from '../../../../../base/common/lifecycle.js';
import { equals } from '../../../../../base/common/objects.js';
import { IAgentConnection } from '../../../../../platform/agentHost/common/agentService.js';
import { IAgentHostConnectionsService } from '../../../../../platform/agentHost/common/agentHostConnectionsService.js';
import { ClaudeLocalAgentConfigKey, IClaudeLocalAgentProfiles } from '../../../../../platform/agentHost/common/claudeLocalAgentConfigSchema.js';
import { ActionType } from '../../../../../platform/agentHost/common/state/protocol/actions.js';
import { ROOT_STATE_URI } from '../../../../../platform/agentHost/common/state/sessionState.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { IWorkbenchContribution } from '../../../../common/contributions.js';
import {
	ClaudeLocalAgentClaudePathSettingId,
	ClaudeLocalAgentSkipPermissionsSettingId,
	ClaudeLocalAgentExtraArgsSettingId,
	ClaudeLocalAgentProfilesSettingId,
	ClaudeLocalAgentActiveProfileSettingId,
} from '../../../../../platform/agentHost/common/agentService.js';

/**
 * The `claudeLocalAgent.*` workbench settings whose values are forwarded.
 * (`enabled` is NOT here — it is a startup gate forwarded as an env var by
 * the agent host starters, not hot-reloadable.)
 */
const CLAUDE_LOCAL_AGENT_SETTING_KEYS: readonly string[] = [
	ClaudeLocalAgentClaudePathSettingId,
	ClaudeLocalAgentSkipPermissionsSettingId,
	ClaudeLocalAgentExtraArgsSettingId,
	ClaudeLocalAgentProfilesSettingId,
	ClaudeLocalAgentActiveProfileSettingId,
];

/**
 * Forwards the workbench user's `claudeLocalAgent.*` settings (except
 * `enabled`) into every connected agent host via `RootConfigChanged`
 * actions, so the `ClaudeCliAgent` can hot-reload its claude path, permission
 * mode, extra args, profiles, and active profile without restarting the
 * agent host process.
 *
 * Mirrors `AgentHostSandboxForwarder`: pushes on connection-online (deferred
 * until the host advertises the schema) and on setting changes; schema-guarded
 * so older hosts are skipped; diff-guarded to avoid push-back loops.
 */
export class ClaudeLocalAgentForwarder extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.claudeLocalAgentForwarder';

	private readonly _scheduled = new Map<IAgentConnection, IDisposable>();
	private _desired: Record<string, unknown> | undefined;

	constructor(
		@IAgentHostConnectionsService private readonly _connectionsService: IAgentHostConnectionsService,
		@IConfigurationService private readonly _configurationService: IConfigurationService,
		@ILogService private readonly _logService: ILogService,
	) {
		super();

		this._register(this._configurationService.onDidChangeConfiguration(e => {
			if (CLAUDE_LOCAL_AGENT_SETTING_KEYS.some(key => e.affectsConfiguration(key))) {
				this._desired = undefined;
				this._pushToAllConnections();
			}
		}));

		this._register(this._connectionsService.onDidChangeConnections(() => {
			this._syncConnectionListeners();
		}));
		this._syncConnectionListeners();
	}

	private _syncConnectionListeners(): void {
		const live = new Set<IAgentConnection>();
		for (const info of this._connectionsService.connections) {
			if (!info.connection) {
				continue;
			}
			live.add(info.connection);
			if (!this._scheduled.has(info.connection)) {
				this._scheduleInitialPush(info.connection);
			}
		}
		for (const [connection, listener] of this._scheduled) {
			if (!live.has(connection)) {
				listener.dispose();
				this._scheduled.delete(connection);
			}
		}
	}

	private _scheduleInitialPush(connection: IAgentConnection): void {
		if (this._tryPush(connection)) {
			this._scheduled.set(connection, Disposable.None);
			return;
		}
		const listener = connection.rootState.onDidChange(() => {
			if (this._tryPush(connection)) {
				this._scheduled.get(connection)?.dispose();
				this._scheduled.set(connection, Disposable.None);
			}
		});
		this._scheduled.set(connection, listener);
	}

	private _pushToAllConnections(): void {
		for (const info of this._connectionsService.connections) {
			if (info.connection) {
				this._tryPush(info.connection);
			}
		}
	}

	/**
	 * Dispatch the desired claude-local-agent config to `connection`. Returns
	 * `true` once the host advertises our schema keys (whether or not a
	 * dispatch was needed); `false` if the schema is not yet available.
	 */
	private _tryPush(connection: IAgentConnection): boolean {
		const rootState = connection.rootState.value;
		if (!rootState || rootState instanceof Error) {
			return false;
		}
		const schemaProperties = rootState.config?.schema.properties;
		if (!schemaProperties?.[ClaudeLocalAgentConfigKey.Profiles]) {
			return false;
		}
		const desired = this._getDesired();
		const current = rootState.config?.values ?? {};
		// Dispatch if the desired slice differs from the host's current slice.
		const currentSlice: Record<string, unknown> = {};
		for (const k of Object.keys(desired)) {
			currentSlice[k] = (current as Record<string, unknown>)[k];
		}
		if (!equals(currentSlice, desired)) {
			this._logService.debug('[ClaudeLocalAgentForwarder] Pushing claudeLocalAgent.* root config');
			connection.dispatch(ROOT_STATE_URI, {
				type: ActionType.RootConfigChanged,
				config: desired,
			});
		}
		return true;
	}

	private _getDesired(): Record<string, unknown> {
		if (this._desired === undefined) {
			this._desired = this._computeDesired();
		}
		return this._desired;
	}

	private _computeDesired(): Record<string, unknown> {
		const desired: Record<string, unknown> = {};
		desired[ClaudeLocalAgentConfigKey.ClaudePath] = this._configurationService.getValue<string>(ClaudeLocalAgentClaudePathSettingId);
		desired[ClaudeLocalAgentConfigKey.SkipPermissions] = this._configurationService.getValue<boolean>(ClaudeLocalAgentSkipPermissionsSettingId);
		desired[ClaudeLocalAgentConfigKey.ExtraArgs] = this._configurationService.getValue<readonly string[]>(ClaudeLocalAgentExtraArgsSettingId);
		desired[ClaudeLocalAgentConfigKey.Profiles] = this._configurationService.getValue<IClaudeLocalAgentProfiles>(ClaudeLocalAgentProfilesSettingId);
		desired[ClaudeLocalAgentConfigKey.ActiveProfile] = this._configurationService.getValue<string>(ClaudeLocalAgentActiveProfileSettingId);
		return desired;
	}

	override dispose(): void {
		for (const listener of this._scheduled.values()) {
			listener.dispose();
		}
		this._scheduled.clear();
		super.dispose();
	}
}
