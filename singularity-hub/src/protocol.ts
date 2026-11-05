// JSON-RPC 2.0 contract between the Singularity IDE and the Singularity Hub.
// Transport: WebSocket on 127.0.0.1, path /ws, one JSON-RPC message per frame (no batches).

export const HUB_NAME = 'singularity-hub';
export const HUB_VERSION = '0.1.0';

/** Range of protocol versions this build speaks. Bump `max` when the wire contract changes. */
export const PROTOCOL = { min: 1, max: 1 } as const;

export const WS_PATH = '/ws';
export const IDENTITY_PATH = '/identity';

export const ErrorCode = {
	ParseError: -32700,
	InvalidRequest: -32600,
	MethodNotFound: -32601,
	InvalidParams: -32602,
	InternalError: -32603,
	/** hub.hello was not completed before another method was called. */
	NotInitialized: -32002,
	IncompatibleProtocol: -32001,
	SessionNotFound: -32004,
	/** fromSeq is older than what the in-memory log still holds. */
	ReplayGap: -32005,
} as const;

export type SessionStatus = 'running' | 'waiting' | 'done' | 'failed' | 'idle';

/** The model a session really runs, as the service itself reports it (not just what was asked for). */
export interface ModelInfo {
	providerID: string;
	modelID: string;
	/** Effort level (the service's "variant"). Absent: the model's own default. */
	variant?: string;
}

export interface Session {
	id: string;
	/** Id of the agent service that runs the session (`opencode`, `claude-code` or `codex-cli`). */
	harness: string;
	model?: ModelInfo;
	title?: string;
	status: SessionStatus;
	recovery?: 'unrecoverable';
	historical?: boolean;
	createdAt?: number;
	updatedAt?: number;
	summary?: string;
	workspace?: string;
	version?: string;
	prompt?: string;
	result?: string;
	/** Claude Code / Codex CLI: permission mode the session was created with (never a bypass mode). */
	permissionMode?: string;
	/** Claude Code / Codex CLI: the CLI conversation exists, so the session can be resumed after it is archived. */
	resumable?: boolean;
	/** Codex CLI: id of the CLI conversation (thread) the next prompt resumes. Not a secret; not sent to the webview. */
	resumeId?: string;
	/** Numeric usage explicitly returned by the provider, without estimating subscription charges. */
	usage?: { inputTokens?: number; outputTokens?: number; cachedInputTokens?: number; costUsd?: number };
	/** Claude Code and Codex CLI: why the last run failed, when the CLI says so. */
	failure?: 'authentication' | 'usage-limit' | 'model' | 'other';
}

export interface HelloParams {
	client: { name: string; version?: string };
	protocol: { min: number; max: number };
}

export interface HelloResult {
	protocol: number;
	hub: { name: string; version: string; instanceId: string; pid: number; startedAt: string };
	capabilities: string[];
	/** Highest event sequence number published so far. */
	seq: number;
}

export interface SubscribeParams {
	/** Omit to follow every session. */
	sessionId?: string;
	/** Replay retained events with seq > fromSeq before going live. */
	fromSeq?: number;
}

export interface SubscribeResult {
	subscriptionId: string;
	seq: number;
	replayed: number;
}

export interface HubEvent {
	seq: number;
	type: string;
	sessionId?: string;
	data?: unknown;
}

export interface JsonRpcRequest {
	jsonrpc: '2.0';
	id?: string | number | null;
	method: string;
	params?: unknown;
}

export interface JsonRpcError {
	code: number;
	message: string;
	data?: unknown;
}

export type JsonRpcResponse =
	| { jsonrpc: '2.0'; id: string | number | null; result: unknown }
	| { jsonrpc: '2.0'; id: string | number | null; error: JsonRpcError };

/** Picks the highest version both sides support, or undefined. */
export function negotiate(client: { min: number; max: number }): number | undefined {
	const high = Math.min(client.max, PROTOCOL.max);
	return high >= Math.max(client.min, PROTOCOL.min) ? high : undefined;
}

/** What discovery writes to connection.json. The token is NOT in here. */
export interface ConnectionInfo {
	v: 1;
	instanceId: string;
	pid: number;
	port: number;
	startedAt: string;
	hubVersion: string;
	protocol: { min: number; max: number };
}
