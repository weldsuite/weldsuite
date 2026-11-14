# WeldAgent's sandbox on the Kubernetes editions (ADR AI-012 phase 5,
# rust/crates/sandbox): the image of the pods the server starts, one per agent
# conversation or run, under gVisor in the weldsuite-sandbox namespace. It
# holds the tools a model's code needs (Python with numpy, pandas and
# matplotlib, Node.js, git, curl), Chromium for the browser tools, an X
# desktop (Xvfb, Openbox, xdotool, ImageMagick) for computer use, and the
# agent (agent/) that the server talks to on port 8080.
#
# The pod runs it as uid 1000 with a read-only root filesystem; /workspace,
# /home/sandbox, /tmp and /dev/shm are its volumes.
#
#   docker build -t weldsuite-sandbox:dev rust/deploy/sandbox
FROM node:22.20.0-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates curl git jq less procps unzip zip xz-utils file \
    python3 python3-pip python3-venv python3-numpy python3-pandas python3-matplotlib python3-requests \
    poppler-utils \
    chromium \
    xvfb openbox xdotool x11-utils imagemagick \
    fonts-dejavu-core fonts-liberation fonts-noto-color-emoji \
  && rm -rf /var/lib/apt/lists/* \
  # Xvfb writes its compiled keymaps to /var/lib/xkb; the root filesystem is
  # read-only in the pod, so they go to /tmp.
  && rm -rf /var/lib/xkb && ln -s /tmp /var/lib/xkb \
  && mkdir -p /workspace /home/sandbox \
  && chown 1000:1000 /workspace /home/sandbox

COPY --chown=root:root agent/package.json agent/server.mjs /opt/agent/
COPY --chown=root:root agent/lib /opt/agent/lib

ENV HOME=/home/sandbox \
    LANG=C.UTF-8 \
    CHROMIUM_PATH=/usr/bin/chromium \
    PYTHONUSERBASE=/home/sandbox/.local \
    PIP_USER=1 \
    PIP_BREAK_SYSTEM_PACKAGES=1 \
    MPLCONFIGDIR=/home/sandbox/.config/matplotlib

USER 1000:1000
WORKDIR /workspace
EXPOSE 8080
CMD ["node", "/opt/agent/server.mjs"]
