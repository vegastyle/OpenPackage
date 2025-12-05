import { readFile, writeFile, mkdir } from 'fs/promises';
import { join, dirname } from 'path';
import { getOpenPackageDirectories } from './directory.js';
import { logger } from '../utils/logger.js';
import { exists } from '../utils/fs.js';

type KeytarModule = {
	getPassword(service: string, account: string): Promise<string | null>;
	setPassword(service: string, account: string, password: string): Promise<void>;
	deletePassword(service: string, account: string): Promise<boolean>;
};

export type StoredToken = {
	refreshToken: string;
	accessToken?: string;
	expiresAt?: string;
	tokenType?: 'bearer';
	scope?: string;
	receivedAt?: string;
};

export interface TokenStore {
	available(): Promise<boolean> | boolean;
	get(profileName: string): Promise<StoredToken | null>;
	set(profileName: string, value: StoredToken): Promise<void>;
	delete(profileName: string): Promise<void>;
}

/**
 * Primary implementation: store tokens in OS keychain (preferred).
 * Uses a dynamic import so the CLI still runs if keytar is unavailable.
 */
export class KeychainTokenStore implements TokenStore {
	private keytar: KeytarModule | null = null;
	private readonly service: string;

	constructor(service = 'opkg-cli') {
		this.service = service;
	}

	async available(): Promise<boolean> {
		return !!(await this.ensureKeytar());
	}

	async get(profileName: string): Promise<StoredToken | null> {
		const keytar = await this.ensureKeytar();
		if (!keytar) return null;

		const raw = await keytar.getPassword(this.service, profileName);
		if (!raw) return null;

		try {
			return JSON.parse(raw) as StoredToken;
		} catch (error) {
			logger.warn('Failed to parse keychain token entry, deleting it', { error });
			await keytar.deletePassword(this.service, profileName);
			return null;
		}
	}

	async set(profileName: string, value: StoredToken): Promise<void> {
		const keytar = await this.ensureKeytar();
		if (!keytar) {
			throw new Error('Keychain unavailable');
		}
		await keytar.setPassword(this.service, profileName, JSON.stringify(value));
	}

	async delete(profileName: string): Promise<void> {
		const keytar = await this.ensureKeytar();
		if (!keytar) return;
		await keytar.deletePassword(this.service, profileName);
	}

	private async ensureKeytar(): Promise<KeytarModule | null> {
		if (this.keytar) {
			return this.keytar;
		}

		try {
			const mod = (await import('keytar')) as KeytarModule;
			this.keytar = mod;
			return mod;
		} catch (error) {
			logger.debug('Keychain (keytar) not available, fallback will be used', { error });
			this.keytar = null;
			return null;
		}
	}
}

/**
 * Fallback implementation: writes a JSON file in the config directory.
 * Prefer using KeychainTokenStore; this is a compatibility fallback.
 */
export class FileTokenStore implements TokenStore {
	private readonly filePath: string;

	constructor(filePath?: string) {
		const dirs = getOpenPackageDirectories();
		this.filePath = filePath ?? join(dirs.config, 'tokens.json');
	}

	available(): boolean {
		return true;
	}

	async get(profileName: string): Promise<StoredToken | null> {
		const data = await this.readAll();
		return data[profileName] ?? null;
	}

	async set(profileName: string, value: StoredToken): Promise<void> {
		const data = await this.readAll();
		data[profileName] = value;
		await this.writeAll(data);
	}

	async delete(profileName: string): Promise<void> {
		const data = await this.readAll();
		if (profileName in data) {
			delete data[profileName];
			await this.writeAll(data);
		}
	}

	private async readAll(): Promise<Record<string, StoredToken>> {
		try {
			if (!(await exists(this.filePath))) {
				return {};
			}
			const raw = await readFile(this.filePath, 'utf-8');
			return raw ? (JSON.parse(raw) as Record<string, StoredToken>) : {};
		} catch (error) {
			logger.warn('Failed to read token file store, recreating', { error });
			return {};
		}
	}

	private async writeAll(data: Record<string, StoredToken>): Promise<void> {
		try {
			await mkdir(dirname(this.filePath), { recursive: true });
			await writeFile(this.filePath, JSON.stringify(data, null, 2), 'utf-8');
		} catch (error) {
			logger.error('Failed to write token file store', { error });
			throw error;
		}
	}
}

/**
 * Factory to select the best available token store.
 */
export async function createTokenStore(): Promise<TokenStore> {
	const keychainStore = new KeychainTokenStore();
	if (await keychainStore.available()) {
		return keychainStore;
	}

	logger.debug('Using file-based token store fallback');
	return new FileTokenStore();
}

