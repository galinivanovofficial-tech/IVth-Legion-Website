# The IVth Legion website as a container image. Zero npm dependencies, so no install step.
FROM node:24-alpine

ENV NODE_ENV=production \
    PORT=3000 \
    DATA_DIR=/data

WORKDIR /app
COPY package.json ./
COPY src ./src
COPY public ./public
COPY seed ./seed

# Code stays root-owned but world-readable: the site can read it, not modify it
RUN chmod -R a+rX /app

# The database lives in a volume, owned by the unprivileged built-in "node" user
RUN mkdir -p /data && chown node:node /data
USER node

EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/ >/dev/null || exit 1

CMD ["node", "--disable-warning=ExperimentalWarning", "src/broken.js"]
