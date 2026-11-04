# Haraka as WeldMail's MX on the Kubernetes editions (ADR MAIL-010): the RCPT
# TO check against weldsuite serve, SPF/DKIM/DMARC into Authentication-Results,
# and the hand-off to the mail bucket and NATS (plugins/). No mailbox state, no
# database credentials.
#
#   docker build -t weldsuite-haraka:dev rust/deploy/haraka
FROM node:22.20.0-bookworm-slim
ENV NODE_ENV=production
# Haraka reads the names of the certificates in config/tls with openssl.
RUN apt-get update && apt-get install -y --no-install-recommends openssl && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --omit=optional --no-audit --no-fund && npm cache clean --force
COPY config ./config
COPY plugins ./plugins
# Haraka's outbound queue directory (unused: this MX only receives).
RUN mkdir -p /app/queue && chown node:node /app/queue
# An unprivileged port: the Service maps 25 to it.
USER node
EXPOSE 2525
CMD ["node", "node_modules/haraka/bin/haraka", "-c", "/app"]
