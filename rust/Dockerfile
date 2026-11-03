# syntax=docker/dockerfile:1.20
#
# The `weldsuite` image (ADR OPS-013): the Rust backend, one binary on
# distroless, run as nonroot, and the platform SPA it serves from /srv/spa on
# the same origin (SPA_DIR, bins/weldsuite/src/spa.rs). For linux/amd64 and
# linux/arm64. The build stages run on the build machine's own platform: Rust
# cross-compiles for the target, so an arm64 image doesn't build under
# emulation, and the SPA is the same JavaScript for both.
#
# The context is the repo root, because the SPA builds in the pnpm workspace
# and `weldsuite migrate` embeds the journaled Drizzle migrations;
# rust/Dockerfile.dockerignore keeps it to what the stages read.
#
#   docker build -f rust/Dockerfile -t weldsuite:dev .
#   docker buildx build -f rust/Dockerfile --platform linux/amd64,linux/arm64 .
#   docker run --env-file .env -p 8080:8080 weldsuite:dev   (command defaults to `serve`)
#
# The WeldSign signer portal's Node container (ADR FE-017) is a target of the
# same file:
#
#   docker build -f rust/Dockerfile --target sign-portal -t weldsuite-sign-portal:dev .
#   docker build -f rust/Dockerfile --target collab-rooms -t weldsuite-collab-rooms:dev .

ARG RUST_VERSION=1.99.1
ARG NODE_VERSION=22

# ── The frontends' dependencies ─────────────────────────────────────────────
# The manifests alone first, so the install stays cached until a dependency
# changes. Only the platform's and the portal's (`--filter <app>...`).
FROM --platform=$BUILDPLATFORM node:${NODE_VERSION}-bookworm-slim AS web-deps
ENV CI=true \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    PNPM_HOME=/pnpm
RUN corepack enable
WORKDIR /repo
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY patches patches
COPY --parents apps/web/platform/package.json apps/web/sign-portal/package.json packages/*/*/package.json ./
RUN --mount=type=cache,id=weldsuite-pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --ignore-scripts --store-dir /pnpm/store \
      --filter platform... --filter sign-portal... --filter @weldsuite/panel-sdk
COPY packages packages

# ── The platform SPA, built for Kubernetes ──────────────────────────────────
# VITE_RUNTIME_CONFIG=on: the app reads /config.json before it starts and,
# with `backend: "rust"`, calls the API on its own origin
# (apps/web/platform/lib/runtime-config.ts). Nothing else is baked in: one
# image serves every cluster. Then a .br and a .gz of every text file.
FROM web-deps AS spa
COPY apps/web/platform apps/web/platform
COPY rust/docker/precompress.mjs /usr/local/lib/precompress.mjs
RUN set -eux; \
    cd apps/web/platform; \
    VITE_RUNTIME_CONFIG=on NODE_OPTIONS=--max-old-space-size=6144 pnpm build; \
    rm -f dist/stats.html; \
    UV_THREADPOOL_SIZE=16 node /usr/local/lib/precompress.mjs dist; \
    mv dist /spa

# ── WeldDocs' and WeldSheets' rooms (rust/docs/collab-rooms.md) ──────────────
# The workers' DocRoom and SheetRoom with the Node runtime of
# apps/tools/collab-rooms, bundled into one file by esbuild.
FROM --platform=$BUILDPLATFORM node:${NODE_VERSION}-bookworm-slim AS collab-rooms-build
ENV CI=true \
    PNPM_HOME=/pnpm
RUN corepack enable
WORKDIR /repo
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY patches patches
COPY --parents apps/tools/collab-rooms/package.json apps/workers/docs-api/package.json apps/workers/sheets-api/package.json packages/*/*/package.json ./
RUN --mount=type=cache,id=weldsuite-pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --ignore-scripts --store-dir /pnpm/store \
      --filter collab-rooms... --filter docs-api... --filter sheets-api...
COPY packages packages
COPY apps/workers/docs-api apps/workers/docs-api
COPY apps/workers/sheets-api apps/workers/sheets-api
COPY apps/tools/collab-rooms apps/tools/collab-rooms
RUN set -eux; \
    cd apps/tools/collab-rooms; \
    node build.mjs; \
    mkdir /collab; \
    mv dist/server.mjs dist/server.mjs.map /collab/

# The rooms' container: Node and the bundle (configured by the Helm chart's
# collabRooms values: S3, the master database, COLLAB_ROOMS_SECRET).
FROM gcr.io/distroless/nodejs22-debian12:nonroot AS collab-rooms
LABEL org.opencontainers.image.title="weldsuite-collab-rooms" \
      org.opencontainers.image.description="WeldDocs' and WeldSheets' collaborative rooms for the Kubernetes editions" \
      org.opencontainers.image.source="https://github.com/weldsuite/weldsuite" \
      org.opencontainers.image.licenses="AGPL-3.0-only"
WORKDIR /app
COPY --from=collab-rooms-build /collab /app
ENV NODE_ENV=production \
    PORT=8090
USER nonroot:nonroot
EXPOSE 8090
CMD ["--enable-source-maps", "server.mjs"]

# ── WeldPanel's browser SDK, the script the collector serves as /s.js ───────
FROM web-deps AS panel-sdk
RUN set -eux; \
    cd packages/sdk/panel-sdk; \
    pnpm build; \
    mkdir /panel; \
    mv dist/panel.global.js /panel/

# ── The sign portal, TanStack Start's Node build ────────────────────────────
FROM web-deps AS sign-portal-build
COPY apps/web/sign-portal apps/web/sign-portal
RUN set -eux; \
    cd apps/web/sign-portal; \
    pnpm build:node; \
    echo '{"type":"module"}' > dist/package.json; \
    mkdir /portal; \
    mv dist node /portal/

# The portal's container: Node, the build, and nothing else (every
# dependency is bundled). Configured by SIGN_PORTAL_BACKEND=rust,
# SIGN_PORTAL_BACKEND_URL and SIGN_PORTAL_SECRET (the Helm chart sets them).
FROM gcr.io/distroless/nodejs22-debian12:nonroot AS sign-portal
LABEL org.opencontainers.image.title="weldsuite-sign-portal" \
      org.opencontainers.image.description="The WeldSign signer portal for the Kubernetes editions" \
      org.opencontainers.image.source="https://github.com/weldsuite/weldsuite" \
      org.opencontainers.image.licenses="AGPL-3.0-only"
WORKDIR /app
COPY --from=sign-portal-build /portal /app
ENV NODE_ENV=production \
    PORT=3000 \
    SIGN_PORTAL_BACKEND=rust
USER nonroot:nonroot
EXPOSE 3000
CMD ["node/server.mjs"]

# ── The backend ─────────────────────────────────────────────────────────────
FROM --platform=$BUILDPLATFORM rust:${RUST_VERSION}-slim-bookworm AS build
ARG TARGETARCH
WORKDIR /src
# The cross toolchain for an arm64 image built elsewhere (aws-lc compiles C).
RUN set -eux; \
    case "$TARGETARCH" in \
      amd64) echo x86_64-unknown-linux-gnu > /rust-target ;; \
      arm64) echo aarch64-unknown-linux-gnu > /rust-target ;; \
      *) echo "unsupported TARGETARCH $TARGETARCH" >&2; exit 1 ;; \
    esac; \
    if [ "$TARGETARCH" = arm64 ] && [ "$(uname -m)" != aarch64 ]; then \
      apt-get update; \
      apt-get install -y --no-install-recommends gcc-aarch64-linux-gnu libc6-dev-arm64-cross; \
      rm -rf /var/lib/apt/lists/*; \
    fi
ENV CARGO_TARGET_AARCH64_UNKNOWN_LINUX_GNU_LINKER=aarch64-linux-gnu-gcc \
    CC_aarch64_unknown_linux_gnu=aarch64-linux-gnu-gcc \
    AR_aarch64_unknown_linux_gnu=aarch64-linux-gnu-ar
# Only what the build reads; tests and fixtures stay out of the cache key.
COPY rust/rust-toolchain.toml ./
RUN rustup target add "$(cat /rust-target)"
COPY rust/Cargo.toml rust/Cargo.lock rust/clippy.toml ./
COPY rust/.cargo .cargo
COPY rust/catalogs catalogs
COPY rust/crates crates
COPY rust/modules modules
COPY rust/bins bins
# The journaled migrations (packages/core/db/drizzle/{master,tenant,personal}-migrations:
# the SQL and each meta/_journal.json, not the snapshots), embedded in the
# binary, so the image needs no files and no Node to migrate
# (crates/migrations/build.rs).
COPY packages/core/db/drizzle drizzle
ENV WELDSUITE_DRIZZLE_DIR=/src/drizzle
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/src/target,id=weldsuite-target-${TARGETARCH} \
    target="$(cat /rust-target)" \
 && cargo build --release --locked --bin weldsuite --target "$target" \
 && cp "target/$target/release/weldsuite" /weldsuite

# glibc + libgcc + CA certificates, no shell, uid 65532. The last stage, so
# a build without --target makes this image.
FROM gcr.io/distroless/cc-debian12:nonroot
LABEL org.opencontainers.image.title="weldsuite" \
      org.opencontainers.image.description="The WeldSuite backend and platform" \
      org.opencontainers.image.source="https://github.com/weldsuite/weldsuite" \
      org.opencontainers.image.licenses="AGPL-3.0-only"
COPY --from=build /weldsuite /usr/local/bin/weldsuite
COPY --from=spa /spa /srv/spa
# WeldPanel's SDK bundle (PANEL_SDK_FILE's default).
COPY --from=panel-sdk /panel /srv/panel
# Serve the SPA for every path the API doesn't answer; SPA_DIR= (empty) for
# the API alone.
ENV SPA_DIR=/srv/spa
USER nonroot:nonroot
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/weldsuite"]
CMD ["serve"]
