# Built from the repository root (see docker-compose.yml) so the renderer can use
# the studio's own size table, tint engine and packing engine unchanged.
FROM node:20-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends fonts-liberation && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json ./package.json
COPY src/constants ./src/constants
COPY src/utils/packingStrategies.js src/utils/garmentTintEngine.js src/utils/bgRemovalUtils.js ./src/utils/
WORKDIR /app/render-api
COPY render-api/package.json render-api/package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund
COPY render-api/*.js ./
ENV NODE_ENV=production PORT=8080 GARMENT_DIR=/garment-data DATA_DIR=/data
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 8080
CMD ["node", "server.js"]
