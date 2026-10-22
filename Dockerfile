# NickFlix — Node 22 + ffmpeg (for compatibility mode: MKV/AVI/HEVC → browser-friendly MP4)
FROM node:22-bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY server ./server
COPY client ./client

ENV PORT=10000
EXPOSE 10000
CMD ["node", "server/index.js"]
