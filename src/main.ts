import { loadWorkerRuntimeConfigFromEnv } from "./config.js";
import { createWorkerBeeSocketServer } from "./rpc.js";
import { initializeMarketInsightsFromEnv } from "./tools/market-insights.js";

const socketPath =
	process.env.BEE_PI_AGENT_SOCKET || process.env.PI_AGENT_WORKER_RPC_SOCKET || "/var/run/bee/worker.sock";

async function main(): Promise<void> {
	const runtimeConfig = loadWorkerRuntimeConfigFromEnv();
	const stateDir = runtimeConfig.workspace.stateDir || `${runtimeConfig.workspace.rootDir}/.fabee-pi-agent`;
	await initializeMarketInsightsFromEnv(stateDir);
	await createWorkerBeeSocketServer(socketPath, runtimeConfig);
}

void main().catch((error) => {
	console.error(error);
	process.exit(1);
});
