# syntax=docker/dockerfile:1.7
#
# The `weldsuite` image: one binary on distroless, run as nonroot, for
# linux/amd64 and linux/arm64. The build stage runs on the build machine's own
# platform and cross-compiles for the target, so an arm64 image doesn't build
# under emulation.
#
# Build from rust/:  docker build -t weldsuite:dev rust
#                    docker buildx build --platform linux/amd64,linux/arm64 rust
# Run:               docker run --env-file .env -p 8080:8080 weldsuite:dev   (command defaults to `serve`)

ARG RUST_VERSION=1.99.1

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
COPY rust-toolchain.toml ./
RUN rustup target add "$(cat /rust-target)"
COPY Cargo.toml Cargo.lock clippy.toml ./
COPY .cargo .cargo
COPY catalogs catalogs
COPY crates crates
COPY modules modules
COPY bins bins
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/src/target,id=weldsuite-target-${TARGETARCH} \
    target="$(cat /rust-target)" \
 && cargo build --release --locked --bin weldsuite --target "$target" \
 && cp "target/$target/release/weldsuite" /weldsuite

# glibc + libgcc + CA certificates, no shell, uid 65532.
FROM gcr.io/distroless/cc-debian12:nonroot
LABEL org.opencontainers.image.title="weldsuite" \
      org.opencontainers.image.description="The WeldSuite backend" \
      org.opencontainers.image.source="https://github.com/weldsuite/weldsuite" \
      org.opencontainers.image.licenses="AGPL-3.0-only"
COPY --from=build /weldsuite /usr/local/bin/weldsuite
USER nonroot:nonroot
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/weldsuite"]
CMD ["serve"]
