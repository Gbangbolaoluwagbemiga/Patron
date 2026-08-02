FROM node:22-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src

ENV NODE_ENV=production
EXPOSE 8788

CMD ["npx", "tsx", "src/index.ts"]
