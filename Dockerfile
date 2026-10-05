FROM oven/bun:1.4.2-alpine

WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

COPY tsconfig.json mikro-orm.config.ts ./
COPY src ./src
COPY docs ./docs
COPY docker/app-entrypoint.sh ./docker/app-entrypoint.sh

RUN bun x tsc --noEmit && chmod +x ./docker/app-entrypoint.sh

ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000

USER bun

ENTRYPOINT ["./docker/app-entrypoint.sh"]
