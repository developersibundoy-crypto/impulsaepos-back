FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
COPY package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build
COPY .env.production ./.env
EXPOSE 4000
CMD ["node", "dist/server.js"]