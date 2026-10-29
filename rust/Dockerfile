# syntax=docker/dockerfile:1.7
#
# The `weldsuite` image: one static-ish binary on distroless, run as nonroot.
# Build from rust/:  docker build -t weldsuite:dev rust
# Run:               docker run --env-file .env -p 8080:8080 weldsuite:dev   (command defaults to `serve`)

ARG RUST_VERSION=1.99.1

FROM rust:${RUST_VERSION}-slim-bookworm AS build
WORKDIR /src
# Only what the build reads; tests and fixtures stay out of the cache key.
COPY rust-toolchain.toml Cargo.toml Cargo.lock clippy.toml ./
COPY .cargo .cargo
COPY catalogs catalogs
COPY crates crates
COPY bins bins
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/src/target \
    cargo build --release --locked --bin weldsuite \
 && cp target/release/weldsuite /weldsuite

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
