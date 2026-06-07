# syntax=docker/dockerfile:1.6
FROM node:22-alpine AS build

RUN apk add --no-cache fontconfig ttf-dejavu

WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev
RUN npm run smoke:chart

FROM node:22-alpine

ARG OCI_SOURCE=https://github.com/fabianmewes-jm/Fabee-pi-agent
LABEL org.opencontainers.image.source="${OCI_SOURCE}"

RUN apk add --no-cache \
    bash \
    git \
    openssh-client \
    jq \
    curl \
    ripgrep \
    ca-certificates \
    fontconfig \
    ttf-dejavu \
    tini \
    python3 \
    py3-pip \
    make

RUN python3 -m venv /opt/bootstrap-venv \
    && /opt/bootstrap-venv/bin/pip install --no-cache-dir --upgrade pip setuptools wheel \
    && /opt/bootstrap-venv/bin/pip install --no-cache-dir uv

RUN addgroup -g 10001 -S app && adduser -S -D -H -u 10001 -G app -h /home/app app

WORKDIR /app
COPY --from=build /app/package*.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/README.md ./README.md
COPY --from=build /app/UPSTREAM.md ./UPSTREAM.md
COPY --from=build /app/charts ./charts

RUN mkdir -p /home/app /workspace /var/run/bee && chown -R 10001:10001 /home/app /workspace /var/run/bee /app

USER 10001:10001

ENV HOME=/home/app
ENV NODE_ENV=production
ENV BEE_PI_AGENT_SOCKET=/var/run/bee/worker.sock
ENV PATH=/opt/bootstrap-venv/bin:${PATH}

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/main.js"]
