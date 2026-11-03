// The seam where the Singularity Hub will plug in.
//
// A HubClient is anything with this shape (the real one will speak JSON-RPC over WebSocket, in a later task):
//
//   getState(): { hub: { status, detail? }, sessions: Session[] }
//   onDidChange(listener): () => void          // called whenever getState() changes; returns an unsubscribe function
//   connect(): Promise<void>                   // not used yet
//   disconnect(): Promise<void>
//   sendInstruction(sessionId, text): Promise<void>
//   control(sessionId, action): Promise<void>  // action: 'pause' | 'resume' | 'stop' | 'approve' | 'reject'
//
// Session = { id, harness, title?, status: 'running'|'waiting'|'done'|'failed'|'idle', summary? }
// Later additions (live events, observed changes) extend Session; the panel only renders what the state carries.

'use strict';

/** The only client for now: there is no Hub, so it reports "disconnected" and never opens a connection. */
class DisconnectedHubClient {
	constructor() {
		this._listeners = new Set();
		this._state = Object.freeze({ hub: Object.freeze({ status: 'disconnected' }), sessions: Object.freeze([]) });
	}

	getState() {
		return this._state;
	}

	onDidChange(listener) {
		this._listeners.add(listener);
		return () => this._listeners.delete(listener);
	}

	async connect() {
		throw new Error('The Singularity Hub is not available yet.');
	}

	async disconnect() { }

	async sendInstruction() {
		throw new Error('No Hub is connected.');
	}

	async control() {
		throw new Error('No Hub is connected.');
	}
}

module.exports = { DisconnectedHubClient };
