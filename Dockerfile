FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
COPY src ./src
RUN npm ci
RUN npm run build

FROM node:22-bookworm-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/*
RUN npm install -g opencode-ai
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY --from=build /app/dist ./dist
COPY prompts ./prompts
COPY docs ./docs
COPY skills ./skills
COPY README.md README.ru.md LICENSE server.json ./

ENV NODE_ENV=production \
    OC_PILOT_MCP_HOST=0.0.0.0 \
    OC_PILOT_MCP_PORT=8787 \
    OC_PILOT_MCP_PATH=/mcp

WORKDIR /workspace
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8787/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "/app/dist/mcp.js", "--http", "--host", "0.0.0.0", "--port", "8787", "--path", "/mcp", "--cwd", "/workspace"]
