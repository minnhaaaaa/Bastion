# VM backend deployment

This Compose stack runs the controller, Postgres, Neo4j, the sandbox worker, and an HTTPS reverse proxy. The frontend is deployed separately to Vercel. It starts a fresh database; it does not copy local projects, provider connections, or run history.

## Configuration

Keep the private `.env.production` file at the repository root, outside Git. Use the application variables documented in `.env.example`, plus these required deployment variables:

- `DEPLOY_NODE_IMAGE`: Debian-based Node image compatible with the workspace's pnpm version. The API Dockerfile installs Git using apt.
- `DEPLOY_POSTGRES_IMAGE`, `DEPLOY_NEO4J_IMAGE`, `DEPLOY_CADDY_IMAGE`: explicitly chosen compatible image tags or digests.
- `DEPLOY_DATA_DIRECTORY`: absolute host directory mounted at the same path in the API container. Keep the blob, agent, workspace, and audit directories beneath it.
- `DEPLOY_HTTP_PORT`, `DEPLOY_HTTPS_PORT`: published proxy ports. Public ACME validation must reach standard HTTP/HTTPS ports.
- `BACKEND_HOST`: public DNS hostname resolving to the VM, without scheme or path.
- `DEPLOY_NEO4J_HEAP_INITIAL`, `DEPLOY_NEO4J_HEAP_MAX`, `DEPLOY_NEO4J_PAGECACHE`: memory allocation for the graph database.

Use Compose service names in internal connection URLs: `postgres`, `neo4j`, and `worker`. Set `WEB_ORIGIN` to the exact frontend HTTPS origin when it is known. Configure the frontend's `VITE_API_URL` with the backend HTTPS origin. Do not grant wildcard CORS.

The API and worker run as the Node image's `node` user. Prepare bind-mount directories owned by that user's numeric UID/GID; official Node images use 1000:1000. Do not recursively change ownership of unrelated host directories. The audit directory must be outside the worker workspace.

Initial deployment uses API-key model authentication. Configure provider credentials only in the backend environment. GitHub OAuth is optional and requires the deployed HTTPS callback described in `docs/GITHUB_OAUTH.md`. Local ChatGPT loopback sign-in is not automatically a remote-server login flow.

## Start

From the repository root, after uploading and configuring the environment:

```sh
chmod 600 .env.production
sudo docker compose --env-file .env.production -f deploy/compose.yml config --quiet
sudo docker compose --env-file .env.production -f deploy/compose.yml up -d --build
sudo docker compose --env-file .env.production -f deploy/compose.yml ps
sudo docker compose --env-file .env.production -f deploy/compose.yml logs --tail=60 api proxy
```

Only the proxy publishes ports. Keep database and worker ports closed in the cloud firewall. Keep the worker on its internal network; do not attach it to the edge network or mount the Docker socket. The API has outbound access for model providers and public Git imports. Database volumes and the private host data directory persist across container recreation. Back them up together with the environment encryption key. Never use `down -v` when retaining data.

The API automatically applies database migrations on startup. It may restart while Neo4j becomes ready on the first boot. Verify the backend's `/health` response over HTTPS before connecting the frontend. A successful image build is not a deployed security or provider-connectivity test.

## Vercel frontend

Import the repository using `apps/web` as the root directory and Vite as the framework. Include workspace files outside the root directory in the build. Use the repository's pnpm version, Node 24, `pnpm build`, and output directory `dist`. Set only `VITE_API_URL` to the public backend HTTPS origin; do not upload the backend environment to Vercel. The committed `apps/web/vercel.json` supplies SPA routing.

After Vercel assigns the production URL, set backend `WEB_ORIGIN` to that exact origin and recreate the API:

```sh
sudo docker compose --env-file .env.production -f deploy/compose.yml up -d api
```

Preview URLs are separate origins and are not automatically trusted. Connect in the dashboard using the private deployment operator token. Reconnect model and repository accounts in this fresh installation.

## Update

```sh
git pull --ff-only origin main
sudo docker compose --env-file .env.production -f deploy/compose.yml up -d --build
```

Finish active runs and approvals before replacing the API. Reserve the VM IP before relying on an IP-derived hostname for a stable OAuth callback. Free DNS names depend on the DNS operator and certificate-authority availability; certificates are acquired by the proxy, not supplied by DNS.
