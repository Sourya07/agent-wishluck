# ---- build the React dashboard
FROM node:22-bookworm-slim AS web
WORKDIR /app/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

# ---- backend (TypeScript run with tsx; serves the built dashboard too)
FROM node:22-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app/backend
COPY backend/package.json backend/package-lock.json ./
RUN npm ci --include=dev && npm cache clean --force
COPY backend/ ./
COPY --from=web /app/frontend/dist /app/frontend/dist
ENV PORT=4000 DB_PATH=/data/wishluck.db FRONTEND_DIST=/app/frontend/dist
VOLUME ["/data"]
EXPOSE 4000
HEALTHCHECK --interval=15s --timeout=3s CMD node -e "fetch('http://localhost:4000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["npx", "tsx", "src/index.ts"]
