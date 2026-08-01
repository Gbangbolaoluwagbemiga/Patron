# node:sqlite ships unflagged-but-experimental since Node 22.5 — no native build
# step, no better-sqlite3-style platform-specific compile to worry about, which is
# exactly why it was picked (see store.ts). Plain node:22-alpine is enough.
FROM node:22-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts

# SQLite file lives here — mount a persistent volume at this path on the host
# platform (Railway: a Volume attached to /app/data) or every deploy wipes state.
RUN mkdir -p /app/data

ENV NODE_ENV=production
EXPOSE 8787

CMD ["npx", "tsx", "src/index.ts"]
