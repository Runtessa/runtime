# syntax=docker/dockerfile:1.7
FROM node:22-alpine AS runner

WORKDIR /app/src/core

# Prepare artifacts first:
# npm run docker:prepare
# docker build -f src/core/Dockerfile .
ENV NPM_CONFIG_UPDATE_NOTIFIER=false
ENV NPM_CONFIG_FUND=false
ENV NPM_CONFIG_AUDIT=false
ENV NPM_CONFIG_PROGRESS=false
ENV NPM_CONFIG_PREFER_OFFLINE=true
ENV NPM_CONFIG_FETCH_RETRIES=10
ENV NPM_CONFIG_FETCH_RETRY_MINTIMEOUT=30000
ENV NPM_CONFIG_FETCH_RETRY_MAXTIMEOUT=300000
ENV NPM_CONFIG_FETCH_TIMEOUT=1800000

COPY .docker-build/core/src/packages/shared /app/src/packages/shared
COPY .docker-build/core/package.json ./
COPY .docker-build/core/package-lock.json ./
RUN --mount=type=cache,target=/root/.npm,id=npm-core,sharing=locked \
    npm ci --omit=dev --ignore-scripts --no-audit --no-fund \
    && npm cache clean --force
RUN mkdir -p /app/src \
    && ln -s /app/src/core/node_modules /app/src/node_modules

COPY .docker-build/core/dist /app/dist
COPY .docker-build/core/public /app/public

ENV NODE_ENV=production
ENV PORT=3005

EXPOSE 3005

CMD ["npm", "run", "start:dist"]
