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

ENTRYPOINT ["/entrypoint.sh"]
