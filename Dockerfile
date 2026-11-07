# NickFlix website — Node 22. (No ffmpeg needed here: video is encoded and
# served by NickFlix Host on your own PC.)
FROM node:22-bookworm-slim

WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY server ./server
COPY client ./client

ENV PORT=10000
EXPOSE 10000
CMD ["node", "server/index.js"]
