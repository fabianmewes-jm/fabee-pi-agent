# syntax=docker/dockerfile:1.6
# Pin Node and Alpine explicitly so tag rebuilds cannot silently move us to
# another Alpine/Python line. Alpine 3.22 provides Python 3.12.x.
ARG NODE_BASE_IMAGE=node:22.19.0-alpine3.22@sha256:d2166de198f26e17e5a442f537754dd616ab069c47cc57b889310a717e0abbf9
FROM ${NODE_BASE_IMAGE} AS build

RUN apk add --no-cache fontconfig

WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev
RUN npm run smoke:chart

FROM ${NODE_BASE_IMAGE}

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
    tini \
    "python3~3.12" \
    py3-pip \
    make

ARG UV_VERSION=0.11.21
RUN python3 -m venv /opt/bootstrap-venv \
    && /opt/bootstrap-venv/bin/pip install --no-cache-dir "uv==${UV_VERSION}"

RUN addgroup -g 10001 -S app && adduser -S -D -H -u 10001 -G app -h /home/app app

WORKDIR /app
COPY --from=build /app/package*.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/README.md ./README.md
COPY --from=build /app/UPSTREAM.md ./UPSTREAM.md
COPY --from=build /app/assets ./assets
COPY --from=build /app/charts ./charts

RUN mkdir -p /home/app /workspace /var/run/bee && chown -R 10001:10001 /home/app /workspace /var/run/bee /app

USER 10001:10001

ENV HOME=/home/app
ENV NODE_ENV=production
ENV BEE_PI_AGENT_SOCKET=/var/run/bee/worker.sock
ENV PATH=/opt/bootstrap-venv/bin:${PATH}

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/main.js"]
