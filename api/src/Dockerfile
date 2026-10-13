FROM node:20-alpine

WORKDIR /app

COPY package*.json ./

RUN npm install

COPY api/src/ ./

EXPOSE 3000

CMD ["node", "server.js"]