FROM node:20-bookworm-slim AS deps
WORKDIR /app
COPY package*.json ./
RUN npm ci

FROM node:20-bookworm-slim AS builder
WORKDIR /app
ARG NEXT_PUBLIC_SUPABASE_URL
ARG NEXT_PUBLIC_SUPABASE_ANON_KEY
ARG NEXT_PUBLIC_SITE_DISABLED
ARG NEXT_PUBLIC_ENABLE_GOOGLE_DRIVE
ENV NEXT_PUBLIC_SUPABASE_URL=$NEXT_PUBLIC_SUPABASE_URL
ENV NEXT_PUBLIC_SUPABASE_ANON_KEY=$NEXT_PUBLIC_SUPABASE_ANON_KEY
ENV NEXT_PUBLIC_SITE_DISABLED=$NEXT_PUBLIC_SITE_DISABLED
ENV NEXT_PUBLIC_ENABLE_GOOGLE_DRIVE=$NEXT_PUBLIC_ENABLE_GOOGLE_DRIVE
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

FROM node:20-bookworm-slim AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000
# LibreOffice en servidor sin X11 (Railway / Docker)
ENV SAL_USE_VCLPLUGIN=headless

RUN apt-get update && apt-get install -y --no-install-recommends \
  ca-certificates \
  libreoffice \
  fonts-dejavu-core \
  && rm -rf /var/lib/apt/lists/* \
  && (soffice --version || libreoffice --version)

COPY --from=builder /app/package*.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/.next ./.next
COPY --from=builder /app/public ./public
COPY --from=builder /app/next.config.ts ./next.config.ts

EXPOSE 3000

CMD ["npm", "run", "start"]
