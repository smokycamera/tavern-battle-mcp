FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY server.mjs broker.mjs tools.mjs stdio-proxy.mjs ./
ENV NODE_ENV=production
ENV TB_MCP_HOST=0.0.0.0
ENV TB_MCP_PORT=8766
USER node
EXPOSE 8766
CMD ["node", "server.mjs"]
