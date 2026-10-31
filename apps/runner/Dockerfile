# The runner (D12): git, gh, the claude CLI, a headless Chromium for D4
# evidence, and Node/pnpm for the target projects. Agents run inside this
# container, so it is "the user's machine" for D2. The user signs in to
# claude, codex and gh here once with `docker exec`; their configs live on volumes.
FROM node:26-bookworm
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
# Same version as "packageManager" in package.json
RUN npm install -g pnpm@12.15.0

# Tools agents and the runner need. Chromium comes from Debian so it runs
# on arm64 and x64 alike. ffmpeg converts evidence videos to H.264 MP4.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl git gnupg chromium ffmpeg fonts-liberation jq \
  && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /usr/share/keyrings/githubcli-archive-keyring.gpg \
  && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list \
  && apt-get update && apt-get install -y --no-install-recommends gh \
  && rm -rf /var/lib/apt/lists/*

# The agent CLIs (D2): installed here, logged in by the user, never configured by Corral.
# The agent browser (D4) agents capture evidence with drives the Debian Chromium
# above instead of downloading its own. Pinned, because this layer is cached
# forever otherwise and each machine keeps whatever it first built; to update,
# change a version here.
ARG CLAUDE_CODE_VERSION=2.1.316
ARG CODEX_VERSION=0.166.0
ARG AGENT_BROWSER_VERSION=0.41.0
RUN npm install -g @anthropic-ai/claude-code@$CLAUDE_CODE_VERSION @openai/codex@$CODEX_VERSION agent-browser@$AGENT_BROWSER_VERSION \
  && npm cache clean --force
ENV AGENT_BROWSER_EXECUTABLE_PATH=/usr/bin/chromium

WORKDIR /app
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY patches patches
COPY packages/tsconfig/package.json packages/tsconfig/
COPY packages/core/package.json packages/core/
COPY packages/contracts/package.json packages/contracts/
COPY apps/runner/package.json apps/runner/
# The store is a BuildKit cache: a lockfile change downloads only what changed
RUN --mount=type=cache,id=corral-pnpm,target=/pnpm/store,sharing=locked \
  pnpm install --store-dir /pnpm/store --frozen-lockfile --prod --filter @corral/runner...

COPY packages/core packages/core
COPY packages/contracts packages/contracts
# Includes apps/runner/skills, which the runner copies into the claude and
# codex skill directories at startup (they're on volumes, so it can't be baked in)
COPY apps/runner apps/runner

ENV NODE_ENV=production
ENV CORRAL_RUNNER_DATA_DIR=/data/runner
ENV CORRAL_RUNNER_NAME=home-server
ENV CORRAL_CLAUDE_BIN=claude
# Headless browsers started by agents find Chromium here
ENV CHROME_BIN=/usr/bin/chromium
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
ENV PUPPETEER_SKIP_DOWNLOAD=1
# claude, codex and gh keep their logins under HOME; those directories are volumes.
# They must exist owned by runner here, or Docker creates the mount points
# as root and the logins can't be saved.
ENV HOME=/home/runner
RUN useradd --create-home --uid 1001 runner \
  && mkdir -p /data/runner /home/runner/.claude /home/runner/.codex /home/runner/.config/gh \
  && chown -R runner:runner /data/runner /home/runner
VOLUME ["/data/runner", "/home/runner/.claude", "/home/runner/.codex", "/home/runner/.config/gh"]
# Last, so a new SHA changes no layer that needs rebuilding
ARG CORRAL_BUILD_SHA=development
ENV CORRAL_BUILD_SHA=$CORRAL_BUILD_SHA
USER runner
WORKDIR /app/apps/runner
CMD ["node", "src/index.ts"]
