/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../nls.js';
import { createSchema, schemaProperty } from './agentHostSchema.js';

/**
 * Top-level root-config keys the agent host exposes for the Claude Local
 * (CLI) agent. These carry the hot-reloadable slice of the
 * `claudeLocalAgent.*` workbench settings — everything except `enabled`
 * (which is a startup gate read from an env var, because the agent host
 * has no unregister path). The renderer forwards these values via
 * `RootConfigChanged` actions (see `ClaudeLocalAgentForwarder`); the
 * `ClaudeCliAgent` reads them through
 * `IAgentConfigurationService.getRootValue` and reacts to
 * `onDidRootConfigChange`.
 */
export const enum ClaudeLocalAgentConfigKey {
	ClaudePath = 'claudeLocalAgentClaudePath',
	SkipPermissions = 'claudeLocalAgentSkipPermissions',
	ExtraArgs = 'claudeLocalAgentExtraArgs',
	Profiles = 'claudeLocalAgentProfiles',
	ActiveProfile = 'claudeLocalAgentActiveProfile',
}

/** A single named profile: a bag of env vars passed to the `claude` CLI. */
export interface IClaudeLocalAgentProfile {
	readonly env?: Record<string, string>;
}

/** Shape of the `profiles` root-config value: profile name → profile. */
export type IClaudeLocalAgentProfiles = Record<string, IClaudeLocalAgentProfile>;

/**
 * Schema for the Claude Local (CLI) agent's hot-reloadable root-config keys.
 * Mirrors the shape of the `claudeLocalAgent.*` workbench settings so the
 * forwarder can push them 1:1.
 */
export const claudeLocalAgentConfigSchema = createSchema({
	[ClaudeLocalAgentConfigKey.ClaudePath]: schemaProperty<string>({
		type: 'string',
		title: localize('claudeLocalAgent.config.claudePath.title', "Claude CLI Path"),
	}),
	[ClaudeLocalAgentConfigKey.SkipPermissions]: schemaProperty<boolean>({
		type: 'boolean',
		title: localize('claudeLocalAgent.config.skipPermissions.title', "Skip Permissions"),
	}),
	[ClaudeLocalAgentConfigKey.ExtraArgs]: schemaProperty<readonly string[]>({
		type: 'array',
		title: localize('claudeLocalAgent.config.extraArgs.title', "Extra CLI Args"),
		items: { type: 'string', title: localize('claudeLocalAgent.config.extraArgs.item.title', "Argument") },
	}),
	[ClaudeLocalAgentConfigKey.Profiles]: schemaProperty<IClaudeLocalAgentProfiles>({
		type: 'object',
		title: localize('claudeLocalAgent.config.profiles.title', "Claude Local Agent Profiles"),
	}),
	[ClaudeLocalAgentConfigKey.ActiveProfile]: schemaProperty<string>({
		type: 'string',
		title: localize('claudeLocalAgent.config.activeProfile.title', "Active Profile"),
	}),
});
