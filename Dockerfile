# syntax=docker/dockerfile:1.7
FROM node:24-alpine AS base
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1

FROM base AS dependencies
COPY package.json package-lock.json ./
RUN npm ci

FROM base AS builder
COPY --from=dependencies /app/node_modules ./node_modules
COPY . .
# Next.js incrusta las variables NEXT_PUBLIC_* en el bundle del navegador
# durante el build, no las lee en ejecucion: si no llegan aqui, quedan
# undefined en el cliente. Solo se declaran las que consume codigo de
# cliente. Los secretos (service role, peppers, DATABASE_URL) NO van aqui:
# se leen en ejecucion y no deben quedar en capas de la imagen.
ARG NEXT_PUBLIC_APP_URL=""
# Sin valor explicito queda apagado: el modo demo falla cerrado hacia Auth.
ARG NEXT_PUBLIC_DEMO_MODE="false"
# La URL del inbox de Kapso NO va aqui: es una credencial portadora y se sirve
# en ejecucion desde /api/kapso-embed solo a sesiones autorizadas (KAPSO_EMBED_URL).
ENV NEXT_PUBLIC_APP_URL=$NEXT_PUBLIC_APP_URL \
    NEXT_PUBLIC_DEMO_MODE=$NEXT_PUBLIC_DEMO_MODE
RUN npm run build

FROM node:24-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0
RUN addgroup --system --gid 1001 nodejs \
    && adduser --system --uid 1001 nextjs
COPY --from=builder /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
USER nextjs
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/api/health || exit 1
CMD ["node", "server.js"]

