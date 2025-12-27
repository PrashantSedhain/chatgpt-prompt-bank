FROM node:20-slim AS build

WORKDIR /app

COPY server/package.json server/package-lock.json ./server/
RUN cd server && npm ci

COPY server ./server
RUN cd server && npm run build && npm prune --omit=dev

FROM node:20-slim

WORKDIR /app
ENV NODE_ENV=production

COPY --from=build /app/server/dist ./dist
COPY --from=build /app/server/node_modules ./node_modules
COPY --from=build /app/server/package.json ./package.json
COPY --from=build /app/server/package-lock.json ./package-lock.json
COPY assets ./assets

ENV PORT=8000
EXPOSE 8000

CMD ["node", "dist/server.js"]

