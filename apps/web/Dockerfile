# The web app (D12): a static Nuxt build (ssr: false) served by Nitro, which
# also proxies /api/** to the server on the Docker network so the browser and
# Cloudflare Access see one hostname. The proxy target is fixed at build time
# by Nuxt's routeRules, so it's a build argument.
FROM node:26-bookworm-slim AS build
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
# Same version as "packageManager" in package.json
RUN npm install -g pnpm@12.15.0

WORKDIR /app
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY patches patches
# All of it, not just package.json: Vite reads base.json when bundling core and contracts
COPY packages/tsconfig packages/tsconfig
COPY packages/core/package.json packages/core/
COPY packages/contracts/package.json packages/contracts/
COPY apps/web/package.json apps/web/
RUN pnpm install --frozen-lockfile --filter @corral/web...

COPY packages/core packages/core
COPY packages/contracts packages/contracts
COPY apps/web apps/web

ARG CORRAL_SERVER_URL=http://server:4100
ENV CORRAL_SERVER_URL=$CORRAL_SERVER_URL
RUN pnpm --filter @corral/web build

FROM node:26-bookworm-slim
WORKDIR /app
COPY --from=build /app/apps/web/.output ./.output
ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3000
EXPOSE 3000
USER node
CMD ["node", ".output/server/index.mjs"]
