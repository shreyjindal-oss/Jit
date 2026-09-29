# Cloud Run image: Node 22, the shared app code (src/) served by server/main.ts, Postgres via Cloud SQL.
FROM node:22-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig*.json ./
COPY src ./src
COPY server ./server
RUN npx esbuild server/main.ts --bundle --platform=node --format=esm --target=node22 \
      --external:pg --external:pg-native --outfile=dist/server.mjs

FROM node:22-slim
ENV NODE_ENV=production
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY migrations-pg ./migrations-pg
USER node
EXPOSE 8080
CMD ["node", "dist/server.mjs"]
