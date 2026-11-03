import type { HubEvent } from './protocol';

/**
 * Sequenced, bounded, in-memory event log. Every published event gets the next `seq`, so a client that
 * reconnects can ask for everything after the last seq it saw. Nothing is persisted to disk.
 */
export class EventLog {
	private events: HubEvent[] = [];
	private _seq = 0;

	constructor(private readonly capacity = 1000) { }

	get seq(): number {
		return this._seq;
	}

	append(event: Omit<HubEvent, 'seq'>): HubEvent {
		const stored: HubEvent = { ...event, seq: ++this._seq };
		this.events.push(stored);
		if (this.events.length > this.capacity) {
			this.events.splice(0, this.events.length - this.capacity);
		}
		return stored;
	}

	/** Events after `fromSeq`. `gap` is true when some of them have already been dropped. */
	since(fromSeq: number, filter?: (e: HubEvent) => boolean): { events: HubEvent[]; gap: boolean } {
		const oldest = this.events.length ? this.events[0].seq : this._seq + 1;
		const gap = fromSeq + 1 < oldest && fromSeq < this._seq;
		const events = this.events.filter(e => e.seq > fromSeq && (!filter || filter(e)));
		return { events, gap };
	}
}
