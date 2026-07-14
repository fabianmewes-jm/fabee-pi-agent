import { loadWorkerRuntimeConfigFromEnv } from "./config.js";
import { createWorkerBeeSocketServer } from "./rpc.js";

const socketPath =
	process.env.BEE_PI_AGENT_SOCKET || process.env.PI_AGENT_WORKER_RPC_SOCKET || "/var/run/bee/worker.sock";

void createWorkerBeeSocketServer(socketPath, loadWorkerRuntimeConfigFromEnv()).catch((error) => {
	console.error(error);
	process.exit(1);
});
