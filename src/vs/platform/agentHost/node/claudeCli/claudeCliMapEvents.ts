/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { URI } from '../../../../base/common/uri.js';
import type { AgentSignal } from '../../common/agentService.js';
import { ActionType } from '../../common/state/sessionActions.js';
import { ResponsePartKind, ToolCallConfirmationReason, ToolResultContentType, type ToolResultContent } from '../../common/state/sessionState.js';

/**
 * Canonical top-level message shapes emitted by the `claude` CLI when run
 * with `--output-format stream-json --verbose`. The CLI emits one JSON
 * object per line on stdout. There are NO `stream_event` envelopes —
 * only the canonical `system` / `assistant` / `user` / `result` messages
 * captured here.
 *
 * These are deliberately loose (most fields optional) so the mapper is
 * resilient to additive CLI changes; we only read the fields we need.
 */
export interface IClaudeCliSystemMessage {
	readonly type: 'system';
	readonly subtype: 'init' | 'hook_started' | 'hook_response' | string;
	readonly session_id?: string;
	readonly model?: string;
	readonly permissionMode?: string;
}

export interface IClaudeCliAssistantMessage {
	readonly type: 'assistant';
	readonly message: {
		readonly id: string;
		readonly type: 'message';
		readonly role: 'assistant';
		readonly model?: string;
		readonly content: readonly IClaudeCliContentBlock[];
		readonly usage?: {
			readonly input_tokens?: number;
			readonly output_tokens?: number;
			readonly cache_read_input_tokens?: number;
		};
	};
}

export interface IClaudeCliUserMessage {
	readonly type: 'user';
	readonly message: {
		readonly content: readonly IClaudeCliContentBlock[];
	};
}

export interface IClaudeCliResultMessage {
	readonly type: 'result';
	readonly subtype: 'success' | 'error_during_execution' | string;
	readonly is_error: boolean | null;
	readonly result?: string;
	readonly session_id?: string;
	readonly model?: string;
	readonly usage?: {
		readonly input_tokens?: number;
		readonly output_tokens?: number;
		readonly cache_read_input_tokens?: number;
	};
	readonly errors?: readonly string[];
}

export type IClaudeCliMessage =
	| IClaudeCliSystemMessage
	| IClaudeCliAssistantMessage
	| IClaudeCliUserMessage
	| IClaudeCliResultMessage
	| { readonly type: string };

/**
 * Content block shapes inside an `assistant.message.content` or
 * `user.message.content` array.
 */
export type IClaudeCliContentBlock =
	| { readonly type: 'thinking'; readonly thinking: string }
	| { readonly type: 'text'; readonly text: string }
	| { readonly type: 'tool_use'; readonly id: string; readonly name: string; readonly input: unknown }
	| { readonly type: 'tool_result'; readonly tool_use_id: string; readonly is_error: boolean | null; readonly content: unknown }
	| { readonly type: string };

/**
 * Result of mapping a single canonical CLI line. `capturedSessionId` is
 * set only when the line was a `system/init` carrying a `session_id`;
 * the agent stores it so subsequent turns can `--resume` it.
 */
export interface IClaudeCliMapResult {
	readonly signals: readonly AgentSignal[];
	readonly capturedSessionId?: string;
}

/**
 * Map one parsed CLI stream-json line to zero or more {@link AgentSignal}s.
 *
 * @param line   The parsed JSON object from one stdout line.
 * @param session The session URI signals should be addressed to.
 * @param turnId  The protocol turn id for the in-flight turn.
 */
export function mapClaudeCliLine(line: IClaudeCliMessage, session: URI, turnId: string): IClaudeCliMapResult {
	if (line.type === 'system') {
		const sys = line as IClaudeCliSystemMessage;
		if (sys.subtype === 'init' && typeof sys.session_id === 'string') {
			return { signals: [], capturedSessionId: sys.session_id };
		}
		// hook_started / hook_response / other system subtypes are noise.
		return { signals: [] };
	}

	if (line.type === 'assistant') {
		const msg = line as IClaudeCliAssistantMessage;
		return { signals: mapAssistantMessage(msg, session, turnId) };
	}

	if (line.type === 'user') {
		const msg = line as IClaudeCliUserMessage;
		return { signals: mapUserMessage(msg, session, turnId) };
	}

	if (line.type === 'result') {
		const msg = line as IClaudeCliResultMessage;
		return { signals: mapResultMessage(msg, session, turnId) };
	}

	return { signals: [] };
}

function mapAssistantMessage(message: IClaudeCliAssistantMessage, session: URI, turnId: string): AgentSignal[] {
	const signals: AgentSignal[] = [];
	const messageId = message.message.id;
	const content = message.message.content;
	for (let i = 0; i < content.length; i++) {
		const block = content[i];
		// NOTE: partId includes the block TYPE so that thinking and text parts
		// never collide. Some Anthropic-compatible backends (e.g. DeepSeek's
		// /anthropic gateway) emit thinking and text as two separate assistant
		// messages that share the SAME message.id — so `${turnId}#${messageId}#${i}`
		// would collide (both blocks are index 0 in their respective messages)
		// and the reducer would drop the second part. Including the type makes
		// each part id unique within a turn.
		const partId = `${turnId}#${messageId}#${block.type}#${i}`;

		if (block.type === 'thinking') {
			const thinking = (block as { readonly type: 'thinking'; readonly thinking: string }).thinking;
			signals.push({
				kind: 'action',
				session,
				action: {
					type: ActionType.ChatResponsePart,
					turnId,
					part: {
						kind: ResponsePartKind.Reasoning,
						id: partId,
						content: '',
					},
				},
			});
			signals.push({
				kind: 'action',
				session,
				action: {
					type: ActionType.ChatReasoning,
					turnId,
					partId,
					content: thinking,
				},
			});
			continue;
		}

		if (block.type === 'text') {
			const text = (block as { readonly type: 'text'; readonly text: string }).text;
			signals.push({
				kind: 'action',
				session,
				action: {
					type: ActionType.ChatResponsePart,
					turnId,
					part: {
						kind: ResponsePartKind.Markdown,
						id: partId,
						content: '',
					},
				},
			});
			signals.push({
				kind: 'action',
				session,
				action: {
					type: ActionType.ChatDelta,
					turnId,
					partId,
					content: text,
				},
			});
			continue;
		}

		if (block.type === 'tool_use') {
			const toolBlock = block as { readonly type: 'tool_use'; readonly id: string; readonly name: string; readonly input: unknown };
			const toolCallId = toolBlock.id;
			const toolName = toolBlock.name;
			const toolInputString = safeStringifyInput(toolBlock.input);
			signals.push({
				kind: 'action',
				session,
				action: {
					type: ActionType.ChatToolCallStart,
					turnId,
					toolCallId,
					toolName,
					displayName: toolName,
				},
			});
			// Mirror streaming by emitting a delta with the full input before
			// Ready. The renderer reducer treats this as a partial-params
			// append; ChatToolCallReady then finalizes the tool call.
			signals.push({
				kind: 'action',
				session,
				action: {
					type: ActionType.ChatToolCallDelta,
					turnId,
					toolCallId,
					content: toolInputString,
				},
			});
			signals.push({
				kind: 'action',
				session,
				action: {
					type: ActionType.ChatToolCallReady,
					turnId,
					toolCallId,
					invocationMessage: toolName,
					toolInput: toolInputString,
					confirmed: ToolCallConfirmationReason.NotNeeded,
				},
			});
			continue;
		}

		// Unknown block kind — ignore defensively.
	}

	return signals;
}

function mapUserMessage(message: IClaudeCliUserMessage, session: URI, turnId: string): AgentSignal[] {
	const signals: AgentSignal[] = [];
	for (const block of message.message.content) {
		if (block.type !== 'tool_result') {
			continue;
		}
		const toolResult = block as { readonly type: 'tool_result'; readonly tool_use_id: string; readonly is_error: boolean | null; readonly content: unknown };
		const isError = toolResult.is_error === true;
		const content = extractToolResultContent(toolResult.content);
		const pastTenseMessage = isError
			? `Tool ${toolResult.tool_use_id} failed`
			: `Tool ${toolResult.tool_use_id} completed`;
		signals.push({
			kind: 'action',
			session,
			action: {
				type: ActionType.ChatToolCallComplete,
				turnId,
				toolCallId: toolResult.tool_use_id,
				result: {
					success: !isError,
					pastTenseMessage,
					...(content.length > 0 ? { content } : {}),
				},
			},
		});
	}
	return signals;
}

function mapResultMessage(message: IClaudeCliResultMessage, session: URI, turnId: string): AgentSignal[] {
	const signals: AgentSignal[] = [];
	const isError = message.is_error === true || message.subtype !== 'success';
	const usage = message.usage;
	const model = message.model;

	if (!isError) {
		signals.push({
			kind: 'action',
			session,
			action: {
				type: ActionType.ChatUsage,
				turnId,
				usage: {
					...(usage?.input_tokens !== undefined ? { inputTokens: usage.input_tokens } : {}),
					...(usage?.output_tokens !== undefined ? { outputTokens: usage.output_tokens } : {}),
					...(usage?.cache_read_input_tokens !== undefined ? { cacheReadTokens: usage.cache_read_input_tokens } : {}),
					...(model !== undefined ? { model } : {}),
				},
			},
		});
	} else {
		const errorText = message.result ?? (message.errors ? message.errors.join('\n') : message.subtype);
		signals.push({
			kind: 'action',
			session,
			action: {
				type: ActionType.ChatError,
				turnId,
				error: {
					errorType: message.subtype,
					message: errorText,
				},
			},
		});
	}

	// The CLI agent emits ChatTurnComplete itself when the terminal `result`
	// line arrives — unlike the SDK agent, whose pipeline owns turn-complete.
	signals.push({
		kind: 'action',
		session,
		action: {
			type: ActionType.ChatTurnComplete,
			turnId,
		},
	});

	return signals;
}

/**
 * Project the CLI's `tool_result.content` (which may be a bare string or an
 * array of typed content blocks) into the protocol's
 * {@link ToolResultContent} shape. Non-text blocks are dropped.
 */
function extractToolResultContent(content: unknown): ToolResultContent[] {
	if (typeof content === 'string') {
		return [{ type: ToolResultContentType.Text, text: content }];
	}
	if (!Array.isArray(content)) {
		return [];
	}
	const out: ToolResultContent[] = [];
	for (const block of content) {
		if (block === null || typeof block !== 'object') {
			continue;
		}
		const candidate = block as { readonly type?: unknown; readonly text?: unknown };
		if (candidate.type === 'text' && typeof candidate.text === 'string') {
			out.push({ type: ToolResultContentType.Text, text: candidate.text });
		}
	}
	return out;
}

function safeStringifyInput(input: unknown): string {
	if (typeof input === 'string') {
		return input;
	}
	try {
		return JSON.stringify(input ?? {});
	} catch {
		return '{}';
	}
}
