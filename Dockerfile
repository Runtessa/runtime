# syntax=docker/dockerfile:1.7
FROM docker.io/library/node:22-alpine AS runner
RUN apk add --no-cache bubblewrap

WORKDIR /app/src/core

COPY LICENSE NOTICE THIRD_PARTY_NOTICES.md /app/
COPY licenses /app/licenses


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
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund \
    && npm cache clean --force
RUN mkdir -p /app/src \
    && ln -s /app/src/core/node_modules /app/src/node_modules

COPY .docker-build/core/dist /app/dist
COPY .docker-build/core/public /app/public

ENV NODE_ENV=production
ENV PORT=3005
ENV HOST=0.0.0.0

EXPOSE 3005

USER node

CMD ["npm", "run", "start:dist"]
