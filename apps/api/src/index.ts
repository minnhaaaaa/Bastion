import { loadEnv } from "./env";
import { buildServer } from "./server";

const env = loadEnv();
const { app } = await buildServer({ webOrigin: env.WEB_ORIGIN, logLevel: env.LOG_LEVEL });
await app.listen({ port: env.API_PORT, host: "0.0.0.0" });
