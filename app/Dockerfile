FROM node:20-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

# Ensure runtime data directory exists and is writable when running as non-root.
RUN mkdir -p /app/data && chown -R node:node /app

ENV PORT=3000
ENV NODE_ENV=production

EXPOSE 3000

USER node

CMD ["node", "server.js"]
