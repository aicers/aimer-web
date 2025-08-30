# syntax=docker/dockerfile:1.7

# ---- Builder ----
FROM node:22-slim AS builder
WORKDIR /app

# Install deps including devDependencies required for build (e.g., TypeScript)
ENV NODE_ENV=production
ARG NEXT_PUBLIC_GRAPHQL_ENDPOINT
ENV NEXT_PUBLIC_GRAPHQL_ENDPOINT=${NEXT_PUBLIC_GRAPHQL_ENDPOINT}
COPY package*.json ./
RUN npm ci --include=dev

COPY . .
# Ensure public/ exists even when repo has no static assets
RUN mkdir -p public
RUN npm run build

# ---- Runner ----
FROM node:22-slim AS runner
WORKDIR /app

ENV NODE_ENV=production

# Copy only necessary files for runtime
COPY --from=builder /app/package*.json ./
COPY --from=builder /app/.next ./.next
COPY --from=builder /app/public ./public

# Install production deps only
RUN npm ci --omit=dev

# Default Next.js port (mapped via compose)
EXPOSE 3000

CMD ["npm", "start"]
