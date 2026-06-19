/**
 * Read-only filesystem provider for the game's static assets (the separate assets repo served at
 * `/assets/war2/`, mirrored into `src/assets/` locally in dev).
 *
 * A games-specific customization. Static hosting has no directory listing, so the assets repo
 * publishes a `tree.txt` index (one path per line) alongside the files; this provider fetches it to
 * build the tree (readdir/stat) and fetches each asset on demand (readFile → bytes, so the
 * workbench's media-preview renders images). Async is fine here — assets aren't type-checked, so
 * the synchronous-resolution constraint that affects node_modules doesn't apply.
 *
 * Mounted at `<workspaceFolder>/assets`, merging with the JSON already seeded there from source.
 * `base` is same-origin in both environments (dev: "/src/assets/"; prod: "/assets/war2/").
 */
import {
	FileType,
	FileSystemProviderCapabilities,
	FileSystemProviderError,
	FileSystemProviderErrorCode,
	type IFileSystemProviderWithFileReadWriteCapability,
	type IStat
} from "@brianjenkins94/monaco-vscode-api/main";

const notFound = (): FileSystemProviderError =>
	FileSystemProviderError.create("not found", FileSystemProviderErrorCode.FileNotFound);
const readOnly = (): FileSystemProviderError =>
	FileSystemProviderError.create("read-only", FileSystemProviderErrorCode.NoPermissions);

export function createAssetsProvider(workspaceFolder: string, base: string): IFileSystemProviderWithFileReadWriteCapability {
	const root = workspaceFolder.replace(/\/$/u, "");
	const mount = root + "/assets";
	const assetBase = base.replace(/\/?$/u, "/"); // ensure single trailing slash

	let treePromise: Promise<Set<string>> | undefined;
	const tree = (): Promise<Set<string>> => {
		if (treePromise === undefined) {
			treePromise = fetch(assetBase + "tree.txt")
				.then((res) => (res.ok ? res.text() : ""))
				// Tolerate `find .` output: strip leading "./" and drop the index file itself.
				.then((text) => new Set(
					text.split("\n").map((line) => line.trim().replace(/^\.\//u, "")).filter((line) => line !== "" && line !== "tree.txt")
				))
				.catch(() => new Set<string>());
		}
		return treePromise;
	};

	// path under the mount → "" (mount root) | "<rel>" | undefined (not ours)
	const toRel = (path: string): string | undefined =>
		path === mount ? "" : path.startsWith(mount + "/") ? path.slice(mount.length + 1) : undefined;

	const childrenOf = (files: Set<string>, dir: string): [string, FileType][] => {
		const prefix = dir === "" ? "" : dir + "/";
		const out = new Map<string, FileType>();
		for (const file of files) {
			if (!file.startsWith(prefix)) continue;
			const rest = file.slice(prefix.length);
			const slash = rest.indexOf("/");
			out.set(slash === -1 ? rest : rest.slice(0, slash), slash === -1 ? FileType.File : FileType.Directory);
		}
		return [...out];
	};
	const isDir = (files: Set<string>, rel: string): boolean => {
		const prefix = rel + "/";
		for (const file of files) if (file.startsWith(prefix)) return true;
		return false;
	};

	return {
		capabilities:
			FileSystemProviderCapabilities.FileReadWrite |
			FileSystemProviderCapabilities.PathCaseSensitive |
			FileSystemProviderCapabilities.Readonly,
		onDidChangeCapabilities: (() => ({ dispose() {} })) as never,
		onDidChangeFile: (() => ({ dispose() {} })) as never,
		watch: () => ({ dispose() {} }),

		async stat(resource): Promise<IStat> {
			if (resource.path === mount) return { type: FileType.Directory, ctime: 0, mtime: 0, size: 0 };
			const rel = toRel(resource.path);
			if (rel === undefined || rel === "") throw notFound();
			const files = await tree();
			if (files.has(rel)) return { type: FileType.File, ctime: 0, mtime: 0, size: 0 };
			if (isDir(files, rel)) return { type: FileType.Directory, ctime: 0, mtime: 0, size: 0 };
			throw notFound();
		},

		async readdir(resource): Promise<[string, FileType][]> {
			// Surface the `assets` folder under the workspace root (merges with the seeded JSON).
			if (resource.path === root) return [["assets", FileType.Directory]];
			const rel = toRel(resource.path);
			if (rel === undefined) throw notFound();
			return childrenOf(await tree(), rel);
		},

		async readFile(resource): Promise<Uint8Array> {
			const rel = toRel(resource.path);
			if (rel === undefined || rel === "") throw notFound();
			const res = await fetch(assetBase + rel);
			if (!res.ok) throw notFound();
			return new Uint8Array(await res.arrayBuffer());
		},

		writeFile: async () => { throw readOnly(); },
		mkdir: async () => { throw readOnly(); },
		delete: async () => { throw readOnly(); },
		rename: async () => { throw readOnly(); }
	} as IFileSystemProviderWithFileReadWriteCapability;
}
