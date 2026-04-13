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

RUN curl -L "https://api.beeper.com/desktop/download/linux/x64/stable/com.automattic.beeper.desktop" \
    -o /opt/beeper.AppImage \
    && chmod +x /opt/beeper.AppImage \
    && cd /opt && /opt/beeper.AppImage --appimage-extract \
    && mv squashfs-root beeper \
    && rm /opt/beeper.AppImage

VOLUME /root/.config

EXPOSE 6080 23380

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# Probe through the socat forwarder so both the API and the forwarder are
# exercised — same path external clients use. A socat crash or a Beeper API
# crash both fail the probe. Start period gives Beeper + Matrix sync time.
HEALTHCHECK --interval=30s --timeout=10s --start-period=90s --retries=3 \
    CMD curl -sf http://127.0.0.1:23380/v1/info > /dev/null || exit 1

ENTRYPOINT ["/entrypoint.sh"]
