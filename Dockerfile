FROM node:20-bullseye-slim

WORKDIR /app/src/core

# Build this image from repository root:
# docker build -f src/core/Dockerfile .
COPY src/packages/shared /app/src/packages/shared
COPY src/core/package.json src/core/package-lock.json ./
RUN npm ci

COPY src/core /app/src/core
COPY src/public /app/src/public

ENV NODE_ENV=production
ENV PORT=3005

EXPOSE 3005

CMD ["npm", "run", "start"]
