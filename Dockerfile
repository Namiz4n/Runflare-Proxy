FROM node:22-alpine

WORKDIR /app
ENV NODE_ENV=production

COPY server.js ./
COPY public ./public

USER node

EXPOSE 3000 8000

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD wget -qO- http://127.0.0.1:3000/healthz > /dev/null || exit 1

CMD ["node", "server.js"]
