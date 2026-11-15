# Agent Games Proof Gatekeeper — Fly.io image.
# Uses the pre-built dist/ (TypeScript already compiled on the build VM).
# Secrets (AGENT_GAMES_HMAC_SECRET, KURIER_API_KEY) are set via
# `flyctl secrets set` — NEVER baked into this image or the repo.
FROM node:20-slim
WORKDIR /app

# Runtime deps only (snarkjs + js-sha3). No build tools needed: dist/ is pre-built.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts

COPY dist ./dist
COPY circuits ./circuits

# data/ is a Fly.io persistent volume (seen.json) — mounted at runtime.
RUN mkdir -p /app/data

ENV NODE_ENV=production
EXPOSE 3000
CMD ["node", "dist/src/index.js"]
