FROM node:24-alpine

RUN addgroup -S fit && adduser -S fit -G fit

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY server.js ./
COPY views/    ./views/
COPY public/   ./public/

# HEALTH_DIR and ORGANIZER_DIR are bind-mounted at runtime via docker-compose
ENV PORT=3457 \
    NODE_ENV=production

USER fit

EXPOSE 3457

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -qO- http://localhost:3457/api/health || exit 1

CMD ["node", "server.js"]
