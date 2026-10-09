ARG SANDBOX_NODE_IMAGE
FROM ${SANDBOX_NODE_IMAGE}
WORKDIR /app
COPY sandbox/worker.mjs /app/worker.mjs
USER node
CMD ["node", "/app/worker.mjs"]
