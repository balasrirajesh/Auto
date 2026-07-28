FROM node:20-bullseye-slim

WORKDIR /usr/src/app

# Install native dependencies required by Baileys/libsignal
RUN apt-get update && apt-get install -y \
    libglib2.0-0 \
    libssl3 \
    ca-certificates \
    openssl \
    --no-install-recommends && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm install --production

COPY . .

ENV PORT=3000
ENV NODE_ENV=production
ENV RENDER=true

EXPOSE 3000

# Healthcheck so Render knows the HTTP server is alive
HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3000/ping', r => process.exit(r.statusCode === 200 ? 0 : 1))"

CMD ["npm", "start"]
