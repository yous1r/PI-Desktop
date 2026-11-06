import deploymentSource from "../../../../pi-host/scripts/deploy.mjs?raw";
import recoverySource from "../../../../pi-host/scripts/deploy-recovery.mjs?raw";

/** Vite embeds these sources in Desktop; release archives never override them. */
export function writeDeploymentWorkerScript(): string {
  const files = { "deploy.mjs": deploymentSource, "deploy-recovery.mjs": recoverySource };
  return Object.entries(files).map(([name, source]) => {
    const encoded = Buffer.from(source, "utf8").toString("base64");
    return `NODE_OPTIONS= NODE_PATH= "$worker_node" -e 'require("node:fs").writeFileSync(process.argv[1], Buffer.from(process.argv[2], "base64"), { mode: 384, flag: "wx" })' "$worker_dir/${name}" '${encoded}' || exit 1`;
  }).join("\n");
}
