FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
COPY public ./public
COPY scripts/build.mjs ./scripts/build.mjs
RUN npm run build && npm prune --omit=dev
FROM node:24-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production PORT=8080 DATABASE_PATH=/data/asterism.sqlite
COPY --from=build /app/package*.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY scripts/backup.mjs ./scripts/backup.mjs
RUN apt-get update && apt-get install -y --no-install-recommends gosu && mkdir /data && chown node:node /data
COPY scripts/container-entrypoint.sh /usr/local/bin/asterism-entrypoint
RUN chmod 755 /usr/local/bin/asterism-entrypoint
ENTRYPOINT ["asterism-entrypoint"]
EXPOSE 8080
CMD ["node","dist/server/index.js"]
