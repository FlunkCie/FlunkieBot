FROM node:22-alpine

WORKDIR /app

COPY package.json package-lock.json ./
# better-sqlite3 has no prebuilt binary for musl (Alpine) and compiles from
# source via node-gyp, which needs Python and a C++ toolchain. Install them
# as a virtual package so they're removed again in this same layer, keeping
# the final image free of the build toolchain.
RUN apk add --no-cache --virtual .build-deps python3 make g++ \
    && npm ci --omit=dev \
    && apk del .build-deps

COPY . .

# The SQLite database lives here and is bind-mounted from the host in compose.
RUN mkdir -p /app/data

CMD ["node", "index.js"]
