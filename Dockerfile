# syntax=docker/dockerfile:1
FROM node:24-bookworm-slim AS build

WORKDIR /app
COPY . .
RUN npm ci && npm run build && npm prune --omit=dev

FROM node:24-bookworm-slim AS runtime

ARG VERSION=dev
LABEL org.opencontainers.image.title="Agent Deck" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.source="https://github.com/not-so-fat/agent-deck"

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8000 \
    AGENT_DECK_MCP_HOST=0.0.0.0 \
    AGENT_DECK_MCP_PORT=3001 \
    AGENT_DECK_HOME=/data \
    AGENT_DECK_UI_DIST=/app/apps/agent-deck/dist

WORKDIR /app
COPY --from=build --chown=node:node /app/package.json /app/package-lock.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/packages/backend/package.json ./packages/backend/package.json
COPY --from=build --chown=node:node /app/packages/backend/dist ./packages/backend/dist
COPY --from=build --chown=node:node /app/packages/shared/package.json ./packages/shared/package.json
COPY --from=build --chown=node:node /app/packages/shared/dist ./packages/shared/dist
COPY --from=build --chown=node:node /app/apps/agent-deck/dist ./apps/agent-deck/dist
RUN mkdir -p /data && chown node:node /data

USER node
EXPOSE 8000 3001
VOLUME ["/data"]
HEALTHCHECK --interval=10s --timeout=3s --start-period=15s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||8000)+'/healthz').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]
ENTRYPOINT ["node", "packages/backend/dist/container-entrypoint.js"]
CMD ["backend"]
