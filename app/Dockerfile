FROM node:20-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

ENV PORT=3000
ENV NODE_ENV=production

EXPOSE 3000

USER node

CMD ["node", "server.js"]
