# syntax=docker/dockerfile:1.7

# ---- Builder ----
FROM node:22.21.1-bookworm-slim@sha256:7378f5a4830ef48eb36d1abf4ef398391db562b5c41a0bded83192fbcea21cc8 AS builder
WORKDIR /app

# Install deps including devDependencies required for build (e.g., TypeScript)
ENV NODE_ENV=production
ARG NEXT_PUBLIC_GRAPHQL_ENDPOINT
ENV NEXT_PUBLIC_GRAPHQL_ENDPOINT=${NEXT_PUBLIC_GRAPHQL_ENDPOINT}
RUN corepack enable
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --prod=false

COPY . .
# Ensure public/ exists even when repo has no static assets
RUN mkdir -p public
RUN pnpm run build

# ---- Runner ----
FROM node:22.21.1-bookworm-slim@sha256:7378f5a4830ef48eb36d1abf4ef398391db562b5c41a0bded83192fbcea21cc8 AS runner
WORKDIR /app

ENV NODE_ENV=production

# Copy only necessary files for runtime
RUN corepack enable
COPY --from=builder /app/package.json /app/pnpm-lock.yaml ./
COPY --from=builder /app/.next ./.next
COPY --from=builder /app/public ./public

# Install production deps only
RUN pnpm install --frozen-lockfile --prod

# Default Next.js port (mapped via compose)
EXPOSE 3000

CMD ["pnpm", "start"]
