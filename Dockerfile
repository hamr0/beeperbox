FROM debian:12-slim

ENV DEBIAN_FRONTEND=noninteractive
ENV DISPLAY=:99

RUN apt-get update && apt-get install -y --no-install-recommends \
    xvfb \
    x11vnc \
    novnc \
    websockify \
    openbox \
    dbus-x11 \
    socat \
    nodejs \
    curl \
    ca-certificates \
    libnss3 \
    libatk-bridge2.0-0 \
    libdrm2 \
    libgtk-3-0 \
    libgbm1 \
    libasound2 \
    libxss1 \
    libxtst6 \
    xdg-utils \
    && rm -rf /var/lib/apt/lists/*

# Beeper's download CDN uses "x64" for amd64 and "arm64" for arm64.
# TARGETARCH is set automatically by docker buildx to "amd64", "arm64", etc.
# based on the --platform flag. Verified both archs are published at:
#   https://api.beeper.com/desktop/download/linux/x64/stable/...
#   https://api.beeper.com/desktop/download/linux/arm64/stable/...
ARG TARGETARCH
RUN set -e; \
    case "${TARGETARCH:-amd64}" in \
      amd64) BEEPER_ARCH=x64 ;; \
      arm64) BEEPER_ARCH=arm64 ;; \
      *) echo "unsupported TARGETARCH=${TARGETARCH}" >&2 && exit 1 ;; \
    esac; \
    echo "downloading Beeper Desktop for ${BEEPER_ARCH}"; \
    curl -L "https://api.beeper.com/desktop/download/linux/${BEEPER_ARCH}/stable/com.automattic.beeper.desktop" \
        -o /opt/beeper.AppImage \
    && chmod +x /opt/beeper.AppImage \
    && cd /opt && /opt/beeper.AppImage --appimage-extract \
    && mv squashfs-root beeper \
    && rm /opt/beeper.AppImage

COPY mcp /opt/mcp

VOLUME /root/.config

EXPOSE 6080 23380 23375

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# Probe through the socat forwarder so both the API and the forwarder are
# exercised — same path external clients use. A socat crash or a Beeper API
# crash both fail the probe. Start period gives Beeper + Matrix sync time.
HEALTHCHECK --interval=30s --timeout=10s --start-period=90s --retries=3 \
    CMD curl -sf http://127.0.0.1:23380/v1/info > /dev/null || exit 1

ENTRYPOINT ["/entrypoint.sh"]
