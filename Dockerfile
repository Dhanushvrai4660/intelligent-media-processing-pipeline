FROM node:20-slim

# sharp needs these for its prebuilt binaries / fallback build on some platforms
RUN apt-get update && apt-get install -y --no-install-recommends \
    libvips-dev \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev --no-audit --no-fund

COPY . .

RUN mkdir -p uploads

EXPOSE 3000

CMD ["node", "src/server.js"]
