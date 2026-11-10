import { existsSync } from 'node:fs';
import { realpathSync } from 'node:fs';
import { basename, isAbsolute, join } from 'node:path';
import { ensureSecureDir, readSecureFile, writeFileAtomic } from '../secure';
import { hashToken, newId, newToken, sameSecret } from './security';

export interface Device {
	id: string;
	name: string;
	/** SHA-256 of the device token. The token itself is shown to the phone once and never stored. */
	tokenHash: string;
	createdAt: number;
	lastSeen?: number;
	revokedAt?: number;
}

export interface Workspace { id: string; path: string; name: string }
/**
 * An independent-validation command that the owner registered on Windows, for one authorised workspace. The phone only ever sees
 * the id and the label; the executable and arguments never leave this file, and the phone cannot supply either.
 */
export interface ValidationProfile { id: string; workspaceId: string; label: string; executable: string; args: string[] }

interface Persisted { v: 1; workspaces: Workspace[]; devices: Device[]; tailnetNames: string[]; profiles: ValidationProfile[]; servedPort?: number }

export const MAX_PROFILES = 16;

const isProfile = (value: unknown): value is ValidationProfile => {
	const item = value as Partial<ValidationProfile> | undefined;
	return !!item && typeof item.id === 'string' && typeof item.workspaceId === 'string' && typeof item.label === 'string' && typeof item.executable === 'string' && Array.isArray(item.args) && item.args.every(arg => typeof arg === 'string');
};

export const MAX_DEVICES = 8;
export const MAX_WORKSPACES = 16;
export const DEVICE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Remote access state: authorized workspaces, paired devices (as token hashes) and the private-network names allowed as Host.
 * Lives in an owner-only directory next to the Hub's own state. Remote access is OFF until the user turns it on: this file
 * does not hold an "enabled" flag, because the gateway process simply is not running until then.
 */
export class RemoteStore {
	private data: Persisted = { v: 1, workspaces: [], devices: [], tailnetNames: [], profiles: [] };
	private readonly file: string;

	constructor(readonly directory: string) {
		this.file = join(directory, 'remote-state.json');
		this.load();
	}

	private load(): void {
		if (!existsSync(this.file)) { return; }
		try {
			const parsed = JSON.parse(readSecureFile(this.file)) as Partial<Persisted>;
			if (parsed.v === 1 && Array.isArray(parsed.workspaces) && Array.isArray(parsed.devices)) {
				this.data = { v: 1, workspaces: parsed.workspaces.slice(0, MAX_WORKSPACES), devices: parsed.devices.slice(0, 64), tailnetNames: Array.isArray(parsed.tailnetNames) ? parsed.tailnetNames.slice(0, 4) : [], profiles: Array.isArray(parsed.profiles) ? parsed.profiles.filter(isProfile).slice(0, MAX_PROFILES) : [], ...(Number.isInteger(parsed.servedPort) ? { servedPort: parsed.servedPort } : {}) };
			}
		} catch { /* an unreadable or unprotected file is treated as empty: nothing stays authorized */ }
	}

	private save(): void {
		ensureSecureDir(this.directory);
		writeFileAtomic(this.file, JSON.stringify(this.data));
	}

	// ---------- workspaces ----------

	workspaces(): Workspace[] { return this.data.workspaces.map(item => ({ ...item })); }

	addWorkspace(path: string): Workspace {
		const canonical = realpathSync.native(path);
		const existing = this.data.workspaces.find(item => item.path.toLowerCase() === canonical.toLowerCase());
		if (existing) { return { ...existing }; }
		if (this.data.workspaces.length >= MAX_WORKSPACES) { throw new Error('Limite de workspaces autorizados atingido.'); }
		const item: Workspace = { id: newId(), path: canonical, name: basename(canonical) || canonical };
		this.data.workspaces.push(item);
		this.save();
		return { ...item };
	}

	// ---------- independent-validation profiles ----------

	profiles(workspaceId?: string): ValidationProfile[] { return this.data.profiles.filter(item => !workspaceId || item.workspaceId === workspaceId).map(item => ({ ...item, args: [...item.args] })); }

	profileById(workspaceId: string, id: unknown): ValidationProfile | undefined {
		const found = typeof id === 'string' ? this.data.profiles.find(item => item.id === id && item.workspaceId === workspaceId) : undefined;
		return found && { ...found, args: [...found.args] };
	}

	addProfile(workspaceId: string, label: string, executable: string, args: string[]): ValidationProfile {
		if (!this.workspaceById(workspaceId)) { throw new Error('Workspace não autorizado.'); }
		if (!/^[^\r\n]{1,60}$/.test(label)) { throw new Error('Informe um nome curto para o perfil de teste.'); }
		if (!isAbsolute(executable) || !existsSync(executable)) { throw new Error('O executável do teste precisa ser um caminho absoluto existente.'); }
		if (!Array.isArray(args) || args.length > 20 || args.some(arg => typeof arg !== 'string' || arg.length > 300 || /[\0\r\n]/.test(arg))) { throw new Error('Argumentos inválidos.'); }
		if (this.data.profiles.length >= MAX_PROFILES) { throw new Error('Limite de perfis de teste atingido.'); }
		const item: ValidationProfile = { id: newId(), workspaceId, label, executable, args: [...args] };
		this.data.profiles.push(item);
		this.save();
		return { ...item, args: [...item.args] };
	}

	removeProfile(id: string): boolean {
		const before = this.data.profiles.length;
		this.data.profiles = this.data.profiles.filter(item => item.id !== id);
		if (this.data.profiles.length !== before) { this.save(); return true; }
		return false;
	}

	removeWorkspace(id: string): boolean {
		const before = this.data.workspaces.length;
		this.data.workspaces = this.data.workspaces.filter(item => item.id !== id);
		this.data.profiles = this.data.profiles.filter(item => item.workspaceId !== id);
		if (this.data.workspaces.length !== before) { this.save(); return true; }
		return false;
	}

	workspaceById(id: unknown): Workspace | undefined {
		return typeof id === 'string' ? this.data.workspaces.find(item => item.id === id) : undefined;
	}

	workspaceByPath(path: string | undefined): Workspace | undefined {
		if (!path) { return undefined; }
		return this.data.workspaces.find(item => item.path.toLowerCase() === path.toLowerCase());
	}

	// ---------- private-network names ----------

	tailnetNames(): string[] { return [...this.data.tailnetNames]; }

	/** The loopback port this gateway last published through Tailscale Serve: the only publication it may replace or turn off. */
	servedPort(): number | undefined { return this.data.servedPort; }
	setServedPort(port: number | undefined): void { if (port === undefined) { delete this.data.servedPort; } else { this.data.servedPort = port; } this.save(); }

	setTailnetNames(names: string[]): void {
		this.data.tailnetNames = names.filter(name => /^[a-z0-9.-]{3,253}$/i.test(name)).map(name => name.toLowerCase()).slice(0, 4);
		this.save();
	}

	// ---------- devices ----------

	devices(): Device[] { return this.data.devices.map(item => ({ ...item })); }

	activeDevices(): Device[] { return this.data.devices.filter(item => !item.revokedAt && !this.expired(item)); }

	private expired(item: Device): boolean { return Date.now() - (item.lastSeen ?? item.createdAt) > DEVICE_TTL_MS; }

	/** Creates the device and returns the token, which is the only time it exists in clear text on this side. */
	authorize(name: string): { device: Device; token: string } {
		if (this.activeDevices().length >= MAX_DEVICES) { throw new Error('Limite de dispositivos pareados atingido. Revogue um dispositivo.'); }
		const token = newToken();
		const device: Device = { id: newId(), name: name.slice(0, 40), tokenHash: hashToken(token), createdAt: Date.now() };
		this.data.devices.push(device);
		this.save();
		return { device: { ...device }, token };
	}

	/** The device behind a token, or undefined when the token is unknown, revoked or expired. */
	identify(token: string): Device | undefined {
		const hash = hashToken(token);
		const device = this.data.devices.find(item => sameSecret(item.tokenHash, hash));
		if (!device || device.revokedAt || this.expired(device)) { return undefined; }
		return { ...device };
	}

	touch(id: string): void {
		const device = this.data.devices.find(item => item.id === id);
		// last-seen is kept in memory-granular steps so every request does not rewrite the file
		if (device && Date.now() - (device.lastSeen ?? 0) > 60_000) { device.lastSeen = Date.now(); this.save(); }
	}

	revoke(id: string): boolean {
		const device = this.data.devices.find(item => item.id === id && !item.revokedAt);
		if (!device) { return false; }
		device.revokedAt = Date.now();
		this.save();
		return true;
	}
}
