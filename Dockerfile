# glibc base — @livekit/rtc-node ships a prebuilt native addon that needs it.
FROM node:22-bookworm-slim

ENV NODE_ENV=production

# Build toolchain for @discordjs/opus / sodium-native native builds, plus
# ffmpeg for prism-media's fallbacks.
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 make g++ ca-certificates ffmpeg \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund

COPY LICENSE ./
COPY src ./src

USER node
CMD ["node", "src/index.js"]
