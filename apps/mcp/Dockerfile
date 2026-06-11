# VibeCheck MCP server. Build context is the monorepo root:
#   docker build -f apps/mcp/Dockerfile -t vibecheck-mcp .
# (or just `docker compose up -d --build`).
FROM node:22-slim
WORKDIR /app

# Install all workspaces, then build only what the MCP needs (schema + mcp).
COPY . .
RUN npm ci \
 && npm run build -w @vibecheck/schema \
 && npm run build -w @vibecheck/mcp

ENV NODE_ENV=production
ENV PORT=8787
EXPOSE 8787
CMD ["node", "apps/mcp/dist/index.js"]
