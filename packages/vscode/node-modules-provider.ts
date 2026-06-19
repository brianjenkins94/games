/**
 * CDN-backed, read-only, *eventually-consistent* filesystem provider for node_modules.
 *
 * A games-specific customization (not core workbench behaviour): it mirrors how almostnode resolves
 * dependencies in-browser — bare imports come from a public CDN rather than a local install — so it
 * works in a static deploy (no filesystem). It fetches raw package files from unpkg on demand
 * (package.json, .d.ts, sources) and is registered as a low-priority `file` overlay: it only
 * answers `<workspaceFolder>/node_modules/<pkg>/…` and throws FileNotFound otherwise, so the
 * in-memory provider wins for everything else (the overlay falls through on FileNotFound).
 *
 * Built from primitives re-exported by `@brianjenkins94/monaco-vscode-api/main` so games doesn't
 * depend on @codingame packages directly.
 *
 * Note: this satisfies go-to-definition/browsing into CDN deps, but NOT the TS type-checker, which
 * resolves package.json/exports against a synchronous worker view the async provider can't populate
 * — type-checked source imports must be seeded synchronously instead (see war2's snapshot).
 */
import {
	FileType,
	FileChangeType,
	FileSystemProviderCapabilities,
	FileSystemProviderError,
	FileSystemProviderErrorCode,
	type IFileChange,
	type IFileSystemProviderWithFileReadWriteCapability,
	type IStat
} from "@brianjenkins94/monaco-vscode-api/main";

const notFound = (): FileSystemProviderError =>
	FileSystemProviderError.create("not found", FileSystemProviderErrorCode.FileNotFound);
const readOnly = (): FileSystemProviderError =>
	FileSystemProviderError.create("read-only", FileSystemProviderErrorCode.NoPermissions);

interface UnpkgMeta {
	type: "file" | "directory";
	size?: number;
	files?: { path: string; type: "file" | "directory"; size?: number }[];
}

/** Split a node_modules-relative path into package + subpath, honouring scopes (@scope/name). */
function splitPackage(rel: string): { pkg: string; sub: string } {
	const parts = rel.split("/");
	const count = parts[0]?.startsWith("@") ? 2 : 1;
	return { pkg: parts.slice(0, count).join("/"), sub: parts.slice(count).join("/") };
}

export function createNodeModulesProvider(workspaceFolder: string, versions: Record<string, string>): IFileSystemProviderWithFileReadWriteCapability {
	const prefix = workspaceFolder.replace(/\/$/u, "") + "/node_modules";

	const metaCache = new Map<string, Promise<UnpkgMeta | undefined>>();
	const fileCache = new Map<string, Promise<Uint8Array | undefined>>();

	// ── onDidChangeFile emitter (minimal, conforms to vscode's Event signature) ──
	const listeners = new Set<(e: readonly IFileChange[]) => unknown>();
	const onDidChangeFile = ((listener: (e: readonly IFileChange[]) => unknown, thisArgs?: unknown, disposables?: { dispose(): void }[]) => {
		const bound = thisArgs != null ? listener.bind(thisArgs) : listener;
		listeners.add(bound);
		const disposable = { dispose() { listeners.delete(bound); } };
		if (Array.isArray(disposables)) disposables.push(disposable);
		return disposable;
	}) as never;
	const announced = new Set<string>();
	const announce = (resource: { toString(): string }, change: IFileChange): void => {
		const key = resource.toString();
		if (announced.has(key)) return; // once per resource — enough to make TS re-resolve
		announced.add(key);
		for (const listener of [...listeners]) listener([change]);
	};

	const toRel = (path: string): string | undefined =>
		path === prefix ? "" : path.startsWith(prefix + "/") ? path.slice(prefix.length + 1) : undefined;

	const base = (pkg: string): string => `https://unpkg.com/${pkg}${versions[pkg] != null ? "@" + versions[pkg] : ""}`;

	// Only packages with a pinned version are served. unpkg 302-redirects every *unversioned* request
	// (e.g. `unpkg.com/preact` → `…/preact@10.x`) and the redirect response carries no
	// `Access-Control-Allow-Origin`, so the cross-origin fetch fails CORS — noisily logged by the
	// browser even though we catch the rejection. We can't pin a version synchronously, so we simply
	// don't fetch unpinned packages (type-checking uses the synchronous snapshot, not this provider).
	const served = (rel: string): boolean => versions[splitPackage(rel).pkg] != null;

	// Cache 404s (real misses) and successes; let transient failures (network/5xx/429) retry.
	const fetchMeta = (rel: string): Promise<UnpkgMeta | undefined> => {
		if (!served(rel)) return Promise.resolve(undefined);
		if (!metaCache.has(rel)) {
			const { pkg, sub } = splitPackage(rel);
			const promise = fetch(`${base(pkg)}/${sub}?meta`)
				.then(async (res) => {
					if (res.ok) return (await res.json()) as UnpkgMeta;
					if (res.status === 404) return undefined;
					metaCache.delete(rel);
					return undefined;
				})
				.catch(() => { metaCache.delete(rel); return undefined; });
			metaCache.set(rel, promise);
		}
		return metaCache.get(rel)!;
	};

	const fetchFile = (rel: string): Promise<Uint8Array | undefined> => {
		if (!served(rel)) return Promise.resolve(undefined);
		if (!fileCache.has(rel)) {
			const { pkg, sub } = splitPackage(rel);
			const promise = fetch(`${base(pkg)}/${sub}`)
				.then(async (res) => {
					if (res.ok) return new Uint8Array(await res.arrayBuffer());
					if (res.status === 404) return undefined;
					fileCache.delete(rel);
					return undefined;
				})
				.catch(() => { fileCache.delete(rel); return undefined; });
			fileCache.set(rel, promise);
		}
		return fileCache.get(rel)!;
	};

	return {
		capabilities:
			FileSystemProviderCapabilities.FileReadWrite |
			FileSystemProviderCapabilities.PathCaseSensitive |
			FileSystemProviderCapabilities.Readonly,
		onDidChangeCapabilities: (() => ({ dispose() {} })) as never,
		onDidChangeFile,
		watch: () => ({ dispose() {} }),

		async stat(resource): Promise<IStat> {
			const rel = toRel(resource.path);
			if (rel === undefined) throw notFound();
			if (rel === "") return { type: FileType.Directory, ctime: 0, mtime: 0, size: 0 };
			const meta = await fetchMeta(rel);
			if (meta === undefined) throw notFound();
			announce(resource, { resource: resource as never, type: FileChangeType.ADDED });
			return {
				type: meta.type === "directory" ? FileType.Directory : FileType.File,
				ctime: 0,
				mtime: 0,
				size: meta.size ?? 0
			};
		},

		async readFile(resource): Promise<Uint8Array> {
			const rel = toRel(resource.path);
			if (rel === undefined || rel === "") throw notFound();
			const data = await fetchFile(rel);
			if (data === undefined) throw notFound();
			announce(resource, { resource: resource as never, type: FileChangeType.UPDATED });
			return data;
		},

		async readdir(resource): Promise<[string, FileType][]> {
			const rel = toRel(resource.path);
			if (rel === undefined) throw notFound();
			if (rel === "") return [];
			const meta = await fetchMeta(rel);
			if (meta === undefined || meta.type !== "directory") throw notFound();
			return (meta.files ?? []).map((entry) => [
				entry.path.split("/").filter(Boolean).pop() ?? "",
				entry.type === "directory" ? FileType.Directory : FileType.File
			]);
		},

		writeFile: async () => { throw readOnly(); },
		mkdir: async () => { throw readOnly(); },
		delete: async () => { throw readOnly(); },
		rename: async () => { throw readOnly(); }
	} as IFileSystemProviderWithFileReadWriteCapability;
}
