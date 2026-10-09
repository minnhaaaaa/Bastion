ARG SANDBOX_NODE_IMAGE
FROM ${SANDBOX_NODE_IMAGE}
WORKDIR /app
COPY sandbox/worker.mjs /app/worker.mjs
COPY sandbox/target.mjs /app/target.mjs
USER node
CMD ["node", "/app/worker.mjs"]
