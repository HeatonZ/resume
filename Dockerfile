
FROM denoland/deno:latest

WORKDIR /app

# frontend build uses npm script (see scripts/web-build.ts)
RUN apt-get update \
  && apt-get install -y --no-install-recommends nodejs npm ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY . .

# Install frontend deps so vite is available for `npm run build`.
RUN npm ci --prefix frontend

# Build frontend assets and warm Deno cache for runtime startup.
RUN deno task build
RUN deno cache backend/main.ts

ENV API_HOST=0.0.0.0
ENV API_PORT=8000

EXPOSE 8000

CMD ["deno", "task", "start", "--unstable-kv"]
