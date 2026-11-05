#!/usr/bin/env node
// Actual plugin/process fixtures over direct service and memory RACP transports.
// This is not mounted Electron or native SSH acceptance.
import { spawnSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const root=resolve(dirname(fileURLToPath(import.meta.url)),"..");
const args=process.argv.slice(2);const index=args.indexOf("--git-plugin");
const gitPlugin=index>=0?args[index+1]:process.env.PI_GIT_PLUGIN_PATH;
if(!gitPlugin)throw new Error("Pass --git-plugin <candidate package directory> to include the real Git workflow");
const env={...process.env,PI_GIT_PLUGIN_PATH:resolve(gitPlugin)};
const run=argv=>{const result=spawnSync(process.execPath,argv,{cwd:root,env,stdio:"inherit"});if(result.error)throw result.error;if(result.status!==0)process.exit(result.status??1);};
run(["--test","apps/desktop/test/workspace-plugin-files-git.test.mjs","apps/desktop/test/workspace-plugin-mcp.test.mjs","apps/desktop/test/workspace-resources.test.mjs","apps/desktop/test/workspace-ports.test.mjs"]);
run(["node_modules/vitest/vitest.mjs","run","apps/pi-host/src/workspace-plugin-racp.test.ts","apps/pi-host/src/workspace-process-racp.test.ts","apps/pi-host/src/workspace-terminal-racp.test.ts"]);
console.log("Direct-service and RACP candidate journeys passed. Native SSH and mounted Electron acceptance are separate gates.");
