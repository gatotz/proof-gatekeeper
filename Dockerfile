# Agent Games Proof Gatekeeper — Fly.io image.
# Multi-stage: compiles TypeScript inside the image (dist/ is gitignored,
# so the repo clone has no pre-built dist/).
# Secrets (AGENT_GAMES_HMAC_SECRET, KURIER_API_KEY) are set via
# `flyctl secrets set` — NEVER baked into this image or the repo.
FROM node:20 AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci --ignore-scripts
COPY src ./src
COPY test ./test
RUN npm run build

FROM node:20-slim
WORKDIR /app

# Runtime deps only (snarkjs + js-sha3). No build tools needed here.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts

COPY --from=build /app/dist ./dist
COPY circuits ./circuits

# data/ is a Fly.io persistent volume (seen.json) — mounted at runtime.
RUN mkdir -p /app/data

ENV NODE_ENV=production
EXPOSE 3000
CMD ["node", "dist/src/index.js"]
