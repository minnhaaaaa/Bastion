ARG DEPLOY_NODE_IMAGE
FROM ${DEPLOY_NODE_IMAGE}
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/*
COPY . .
RUN npm install --global "$(node -p 'require("./package.json").packageManager')" && pnpm install --frozen-lockfile
USER node
WORKDIR /app/apps/api
CMD ["node", "--import", "tsx", "src/index.ts"]
