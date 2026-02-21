FROM node:20-bullseye-slim AS kernel-builder

WORKDIR /app/src/kernel
ARG USE_PREBUILT=false

# Build kernel assets into /app/src/public
COPY src/kernel/package.json src/kernel/package-lock.json ./
RUN npm ci

COPY src/kernel /app/src/kernel
COPY src/public /app/src/public
RUN if [ "$USE_PREBUILT" != "true" ]; then npm run build; fi

FROM node:20-bullseye-slim AS runner

WORKDIR /app/src/core

# Build this image from repository root:
# docker build -f src/core/Dockerfile .
COPY tsconfig.json /app/tsconfig.json
COPY src/packages/shared /app/src/packages/shared
COPY src/core/package.json src/core/package-lock.json ./
RUN npm ci

COPY src/core /app/src/core
COPY --from=kernel-builder /app/src/public /app/src/public

ENV NODE_ENV=production
ENV PORT=3005

EXPOSE 3005

CMD ["npm", "run", "start"]
