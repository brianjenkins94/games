/**
 * A PeerJS broker for browser tests, in a process of its own: PeerJS's server starts timers it never stops (message
 * expiry, broken-connection checks) and has no close, so in the test's process it would keep the test from exiting.
 * Run as a script it listens on a free port and prints it; `startBroker` spawns it and resolves to the port and a stop.
 *
 * (PeerServer, not ExpressPeerServer: the latter starts its WebSocket side only when mounted in an express app.)
 */
import type { AddressInfo } from "node:net";
import { spawn } from "node:child_process";
import { isEntry } from "@brianjenkins94/util/env";
import { PeerServer } from "peer";

export async function startBroker(): Promise<{ "port": number; "stop": () => void }> {
	const child = spawn(process.execPath, [import.meta.filename], { "stdio": ["ignore", "pipe", "inherit"] });
	const port = await new Promise<number>((resolve, reject) => {
		child.once("exit", (code) => { reject(new Error(`the broker exited (${code})`)); });
		child.stdout.once("data", (chunk: Buffer) => { resolve(Number(chunk.toString().trim())); });
	});

	return { "port": port, "stop": () => { child.kill(); } };
}

if (isEntry(import.meta)) {
	PeerServer({ "host": "127.0.0.1", "port": 0, "path": "/" }, (server) => {
		process.stdout.write(`${(server.address() as AddressInfo).port}\n`);
	});
}
