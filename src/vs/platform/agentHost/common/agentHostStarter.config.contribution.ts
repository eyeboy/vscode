/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as nls from '../../../nls.js';
import { PolicyCategory } from '../../../base/common/policy.js';
import { ConfigurationScope, Extensions as ConfigurationExtensions, IConfigurationRegistry } from '../../configuration/common/configurationRegistry.js';
import product from '../../product/common/product.js';
import { Registry } from '../../registry/common/platform.js';
import {
	AgentHostClaudeAgentEnabledSettingId,
	AgentHostCodexAgentBinaryArgsSettingId,
	AgentHostCodexAgentEnabledSettingId,
	AgentHostCodexAgentSdkRootSettingId,
	AgentHostCodexAgentCodexHomeSettingId,
	AgentHostOTelCaptureContentSettingId,
	AgentHostOTelDbSpanExporterEnabledSettingId,
	AgentHostOTelEnabledSettingId,
	AgentHostOTelExporterTypeSettingId,
	AgentHostOTelOtlpEndpointSettingId,
	AgentHostOTelOutfileSettingId,
	ClaudeLocalAgentEnabledSettingId,
	ClaudeLocalAgentClaudePathSettingId,
	ClaudeLocalAgentSkipPermissionsSettingId,
	ClaudeLocalAgentExtraArgsSettingId,
	ClaudeLocalAgentProfilesSettingId,
	ClaudeLocalAgentActiveProfileSettingId,
} from './agentService.js';

// Settings consumed by the agent host starter (`electronAgentHostStarter.ts`
// and `nodeAgentHostStarter.ts`) to populate the spawned agent host process's
// environment. The starter exists in both the desktop main process and the
// remote server process, so this registration has to be visible to both —
// each starter file side-effect-imports this contribution, which causes the
// registration to run as soon as the starter module is loaded. The renderer
// also imports this so the same defaults show up in the settings UI.
//
// Side-effect imports of this file:
//   - `src/vs/platform/agentHost/electron-main/electronAgentHostStarter.ts`
//     (main process, loaded transitively from `app.ts`).
//   - `src/vs/platform/agentHost/node/nodeAgentHostStarter.ts`
//     (remote server, loaded transitively from `serverServices.ts`).
//   - `src/vs/workbench/contrib/chat/browser/chat.shared.contribution.ts`
//     (renderer registration for the settings UI).

const configurationRegistry = Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration);
configurationRegistry.registerConfiguration({
	id: 'chatAgentHostStarter',
	title: nls.localize('chatAgentHostStarterConfigurationTitle', "Chat Agent Host Starter"),
	type: 'object',
	properties: {
		[AgentHostClaudeAgentEnabledSettingId]: {
			type: 'boolean',
			description: nls.localize('chat.agentHost.claudeAgent.enabled', "When enabled, the agent host registers the Claude provider (subject to the Claude SDK being reachable). Independent of `#chat.agents.claude.preferAgentHost#` and `#chat.editor.claude.preferAgentHost#`, which choose which integration surfaces Claude. Requires `#chat.agentHost.enabled#`. The agent host process must be restarted for changes to take effect."),
			default: true,
			tags: ['experimental', 'advanced'],
			// References the `Claude3PIntegration` policy (owned by `github.copilot.chat.claudeAgent.enabled`) so disabling Claude applies across surfaces.
			policyReference: {
				name: 'Claude3PIntegration',
			},
		},
		[AgentHostCodexAgentEnabledSettingId]: {
			type: 'boolean',
			description: nls.localize('chat.agentHost.codexAgent.enabled', "When enabled, the agent host registers the Codex provider (subject to the Codex SDK being reachable). Requires `#chat.agentHost.enabled#`. The agent host process must be restarted for changes to take effect."),
			default: false,
			tags: ['experimental', 'advanced'],
			// Owns the `Codex3PIntegration` policy; gating here disables Codex across all agent-host surfaces.
			policy: {
				name: 'Codex3PIntegration',
				category: PolicyCategory.InteractiveSession,
				minimumVersion: '1.126',
				value: (policyData) => policyData.chat_preview_features_enabled === false ? false : undefined,
				localization: {
					description: {
						key: 'chat.agentHost.codexAgent.enabled.policy',
						value: nls.localize('chat.agentHost.codexAgent.enabled.policy', "Enable Codex Agent sessions in VS Code. Start and resume agentic coding sessions powered by OpenAI Codex SDK. Uses your existing Copilot subscription."),
					}
				}
			},
		},
		[AgentHostCodexAgentSdkRootSettingId]: {
			type: 'string',
			description: nls.localize('chat.agentHost.codexAgent.sdkRoot', "Experimental, for local SDK development only. Absolute path to a directory containing `node_modules/@openai/codex`. When set, the agent host spawns the Codex binary from this tree instead of downloading the SDK. Empty (the default) falls through to the SDK distribution shipped with this build. Requires `#chat.agentHost.enabled#`. The agent host process must be restarted for changes to take effect."),
			default: '',
			tags: ['experimental', 'advanced'],
			included: product.quality !== 'stable',
		},
		[AgentHostCodexAgentCodexHomeSettingId]: {
			type: 'string',
			description: nls.localize('chat.agentHost.codexAgent.codexHome', "Optional override for `$CODEX_HOME`. Controls where the codex binary reads config and writes rollouts. When empty, codex uses its default (`~/.codex`)."),
			default: '',
			tags: ['experimental', 'advanced'],
			included: product.quality !== 'stable',
		},
		[AgentHostCodexAgentBinaryArgsSettingId]: {
			type: 'array',
			items: { type: 'string' },
			description: nls.localize('chat.agentHost.codexAgent.binaryArgs', "Additional command-line arguments passed to `codex app-server`. Primarily useful for debugging (for example, `--log-level=debug`)."),
			default: [],
			tags: ['experimental', 'advanced'],
			included: product.quality !== 'stable',
		},
		[ClaudeLocalAgentEnabledSettingId]: {
			type: 'boolean',
			description: nls.localize('claudeLocalAgent.enabled', "When enabled, the agent host registers a Claude (Local CLI) provider that spawns the locally-installed `claude` CLI and uses your own Claude Code credentials/config (not the in-process SDK or Copilot auth). Requires `#chat.agentHost.enabled#` and `claude` on your PATH (or `#claudeLocalAgent.claudePath#`). This is a startup gate — the agent host process must be restarted for changes to take effect."),
			default: false,
			tags: ['experimental', 'advanced'],
			included: product.quality !== 'stable',
		},
		[ClaudeLocalAgentClaudePathSettingId]: {
			type: 'string',
			description: nls.localize('claudeLocalAgent.claudePath', "Path or command name of the locally-installed `claude` CLI executable. Defaults to `claude` (resolved from PATH). Hot-reloadable: applies to the next turn without restarting the agent host."),
			default: 'claude',
			tags: ['experimental', 'advanced'],
			included: product.quality !== 'stable',
		},
		[ClaudeLocalAgentSkipPermissionsSettingId]: {
			type: 'boolean',
			description: nls.localize('claudeLocalAgent.skipPermissions', "When enabled (the default), passes `--dangerously-skip-permissions` to the `claude` CLI so it runs tools autonomously without blocking on permission prompts. v1 has no permission-prompt UI bridge, so disabling this may cause the CLI to block indefinitely. Hot-reloadable: applies to the next turn."),
			default: true,
			tags: ['experimental', 'advanced'],
			included: product.quality !== 'stable',
		},
		[ClaudeLocalAgentExtraArgsSettingId]: {
			type: 'array',
			items: { type: 'string' },
			description: nls.localize('claudeLocalAgent.extraArgs', "Additional command-line arguments passed to the `claude` CLI (for example, `--model`). Hot-reloadable: applies to the next turn."),
			default: [],
			tags: ['experimental', 'advanced'],
			included: product.quality !== 'stable',
		},
		[ClaudeLocalAgentProfilesSettingId]: {
			type: 'object',
			description: nls.localize('claudeLocalAgent.profiles', "Named profiles for the `claude` CLI, each a bag of environment variables (e.g. `ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_MODEL`, `ANTHROPIC_DEFAULT_*_MODEL`, `CLAUDE_CODE_*`). Switch profiles via `#claudeLocalAgent.activeProfile#` or the model picker. Hot-reloadable. Tokens are stored in plaintext."),
			default: {},
			tags: ['experimental', 'advanced'],
			included: product.quality !== 'stable',
			additionalProperties: {
				type: 'object',
				properties: {
					env: { type: 'object', additionalProperties: { type: 'string' } },
				},
			},
		},
		[ClaudeLocalAgentActiveProfileSettingId]: {
			type: 'string',
			description: nls.localize('claudeLocalAgent.activeProfile', "Name of the active profile in `#claudeLocalAgent.profiles#`. Switching applies to the next turn (hot-reloadable). The model picker also switches profiles when you pick a model belonging to another profile."),
			default: '',
			tags: ['experimental', 'advanced'],
			included: product.quality !== 'stable',
		},
		[AgentHostOTelEnabledSettingId]: {
			type: 'boolean',
			markdownDescription: nls.localize('chat.agentHost.otel.enabled', "When enabled, the agent host emits OpenTelemetry traces from the Copilot SDK. Configurable in user settings only. Requires `#chat.agentHost.enabled#`. Either configure `#chat.agentHost.otel.otlpEndpoint#` to ship traces to an external collector or enable `#chat.agentHost.otel.dbSpanExporter.enabled#` to capture them locally."),
			default: false,
			scope: ConfigurationScope.APPLICATION,
			tags: ['experimental', 'advanced'],
		},
		[AgentHostOTelExporterTypeSettingId]: {
			type: 'string',
			enum: ['otlp-http', 'otlp-grpc', 'console', 'file'],
			markdownDescription: nls.localize('chat.agentHost.otel.exporterType', "Exporter backend used by the Copilot SDK when `#chat.agentHost.otel.enabled#` is on. Configurable in user settings only. `otlp-grpc` is downgraded to `otlp-http` transparently in the CLI runtime."),
			default: 'otlp-http',
			scope: ConfigurationScope.APPLICATION,
			tags: ['experimental', 'advanced'],
		},
		[AgentHostOTelOtlpEndpointSettingId]: {
			type: 'string',
			markdownDescription: nls.localize('chat.agentHost.otel.otlpEndpoint', "OTLP endpoint URL when exporter type is `otlp-http` or `otlp-grpc`. Configurable in user settings only. Sets `OTEL_EXPORTER_OTLP_ENDPOINT` inside the agent host process."),
			default: '',
			scope: ConfigurationScope.APPLICATION,
			tags: ['experimental', 'advanced'],
		},
		[AgentHostOTelCaptureContentSettingId]: {
			type: 'boolean',
			markdownDescription: nls.localize('chat.agentHost.otel.captureContent', "When enabled, includes prompt and response content in OTel span attributes. Configurable in user settings only. Sets `OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT`. Privacy-sensitive: do not enable in environments that ship spans to shared sinks."),
			default: false,
			scope: ConfigurationScope.APPLICATION,
			tags: ['experimental', 'advanced'],
		},
		[AgentHostOTelOutfileSettingId]: {
			type: 'string',
			markdownDescription: nls.localize('chat.agentHost.otel.outfile', "Output path for span JSON lines when exporter type is `file`. Configurable in user settings only. Sets `COPILOT_OTEL_FILE_EXPORTER_PATH`."),
			default: '',
			scope: ConfigurationScope.APPLICATION,
			tags: ['experimental', 'advanced'],
		},
		[AgentHostOTelDbSpanExporterEnabledSettingId]: {
			type: 'boolean',
			markdownDescription: nls.localize('chat.agentHost.otel.dbSpanExporter.enabled', "When enabled, the agent host persists every emitted OTel span to a local SQLite database. Configurable in user settings only. Spans can be inspected via the `Export Agent Host Traces Database` command. Compatible with external exporters: spans are written to SQLite *and* forwarded to the user-configured sink."),
			default: false,
			scope: ConfigurationScope.APPLICATION,
			tags: ['experimental', 'advanced'],
		},
	}
});
