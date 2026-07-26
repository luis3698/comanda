FROM node:22-alpine

WORKDIR /app

# Dependencias primero para aprovechar la cache de capas de Docker.
COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY server/ ./server/
COPY public/ ./public/

ENV NODE_ENV=production
EXPOSE 3000

# Usuario sin privilegios: el proceso nunca corre como root.
USER node

CMD ["node", "server/index.js"]
