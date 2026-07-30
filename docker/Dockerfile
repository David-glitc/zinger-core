FROM node:22-slim AS frontend
WORKDIR /frontend
COPY frontend/package*.json ./
RUN npm install
COPY frontend/ .
RUN npx vite build

FROM node:22-slim
WORKDIR /app

RUN apt-get update && apt-get install -y git && rm -rf /var/lib/apt/lists/*

RUN git clone https://github.com/basedbid-public/openbid.git /tmp/openbid && cd /tmp/openbid && npm install

COPY package*.json ./
RUN npm install

COPY . .
COPY --from=frontend /frontend/dist ./frontend/dist

EXPOSE 3000

CMD ["node", "index.js"]
