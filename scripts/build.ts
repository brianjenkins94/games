import { __root } from "@brianjenkins94/util/env";
import { mapAsync, partition } from "@brianjenkins94/util/array"
import { spawn } from "child_process";
import * as path from "path";
import * as url from "url";

export async function build(workspaces?) {
    workspaces ??= (await new Promise<string[]>(function(resolve, reject) {
        const gitLs = spawn("sh", ["-c", "git ls-files */package.json */*/package.json"]);

        const chunks = []

        gitLs.stdout.on("data", function(chunk) {
            chunks.push(chunk)
        })

        gitLs.on("close", function() {
            resolve(Buffer.concat(chunks).toString().trim().split("\n"));
        })
    })).map(path.dirname);

    function buildOne(workspace) {
        return new Promise(function(resolve, reject) {
            const subprocess = spawn("npm", ["run", "--if-present", "build"], {
                "cwd": workspace,
                "shell": true,
                //"stdio": "inherit"
            });

            subprocess.on("close", function(code) {
                resolve([workspace, code]);
            });
        });
    }

    // Library packages (packages/*) must all finish building before apps (games/*) start,
    // so apps can consume their built dist. Two awaited phases — packages, then apps.
    const [packages, apps] = partition(workspaces, (workspace) => workspace.split("/")[0] === "packages");

    const packageResults = await mapAsync(packages, buildOne);
    const appResults = await mapAsync(apps, buildOne);

    return Object.fromEntries([...packageResults, ...appResults]);
}

if (import.meta.url === url.pathToFileURL(process.argv[1]).toString()) {
	await build();
}
