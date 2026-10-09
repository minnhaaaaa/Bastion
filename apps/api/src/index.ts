import { buildServer } from "./server";

const port = Number(process.env.API_PORT ?? 4000);
const { app } = await buildServer({ webOrigin: process.env.WEB_ORIGIN ?? "http://localhost:5173" });
await app.listen({ port, host: "0.0.0.0" });
