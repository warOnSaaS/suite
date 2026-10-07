# The wOS server: one container with the core, every app's server part and the screens.
# Build from the repo root: docker build -f deploy/Dockerfile -t wos .
FROM node:22-alpine AS build
WORKDIR /app
RUN apk add --no-cache git
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY . .
RUN node scripts/build.mjs
# The board (public) is mounted as it is. The CRM joins the same way once its repo is public:
# docker build --build-arg CRM_REPO=https://github.com/warOnSaaS/crm.git ...
ARG BOARD_REPO=https://github.com/warOnSaaS/agent-kanban.git
ARG CRM_REPO=
RUN mkdir -p vendor && git clone --depth 1 "$BOARD_REPO" vendor/agent-kanban && (cd vendor/agent-kanban && npm install --omit=dev --ignore-scripts --no-audit --no-fund) \
 && if [ -n "$CRM_REPO" ]; then git clone --depth 1 "$CRM_REPO" vendor/crm && (cd vendor/crm && npm install --omit=dev --ignore-scripts --no-audit --no-fund); fi \
 && rm -rf vendor/*/.git
RUN npm prune --omit=dev

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production PORT=8080 WOS_DATA_DIR=/data
COPY --from=build /app /app
RUN mkdir -p /data && chown -R node:node /data
USER node
VOLUME /data
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://127.0.0.1:8080/health || exit 1
CMD ["node", "--disable-warning=ExperimentalWarning", "dist/server/main.mjs"]
