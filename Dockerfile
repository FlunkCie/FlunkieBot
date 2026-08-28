FROM node:22-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

# The SQLite database lives here and is bind-mounted from the host in compose.
RUN mkdir -p /app/data

CMD ["node", "index.js"]
