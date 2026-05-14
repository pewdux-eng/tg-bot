FROM node:20-slim

RUN apt-get update && apt-get install -y \
    ffmpeg \
    python3 \
    python3-pip \
    --no-install-recommends && rm -rf /var/lib/apt/lists/*

RUN pip3 install -U yt-dlp --break-system-packages

WORKDIR /app
COPY package.json ./
RUN npm install
COPY bot.js ./

ENV PORT=3000
EXPOSE 3000
CMD ["node", "bot.js"]
