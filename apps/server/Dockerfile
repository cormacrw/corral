# The control plane (D12). Node runs the TypeScript directly, so there is
# no build step: only the server's workspace packages are installed.
FROM node:26-bookworm-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
# Same version as "packageManager" in package.json
RUN npm install -g pnpm@12.15.0

WORKDIR /app
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY patches patches
COPY packages/tsconfig/package.json packages/tsconfig/
COPY packages/core/package.json packages/core/
COPY packages/contracts/package.json packages/contracts/
COPY packages/db/package.json packages/db/
COPY apps/server/package.json apps/server/
RUN pnpm install --frozen-lockfile --prod --filter @corral/server...

COPY packages/core packages/core
COPY packages/contracts packages/contracts
COPY packages/db packages/db
COPY apps/server apps/server

# Everything environment-specific is configuration (D12); see docker-compose.yml
ARG CORRAL_BUILD_SHA=development
ENV CORRAL_BUILD_SHA=$CORRAL_BUILD_SHA
ENV NODE_ENV=production
ENV CORRAL_SERVER_HOST=0.0.0.0
ENV CORRAL_SERVER_PORT=4100
ENV CORRAL_SERVER_DATA_DIR=/data/server
# Must exist owned by node here, or Docker creates the volume's mount point
# as root and the server can't write blobs or transcripts
RUN mkdir -p /data/server && chown node:node /data/server
VOLUME ["/data/server"]
EXPOSE 4100
USER node
WORKDIR /app/apps/server
CMD ["node", "src/index.ts"]
