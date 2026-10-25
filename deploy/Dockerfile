FROM oven/bun:1
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --production
COPY src/ ./src/
# Run as an unprivileged system user: LMDB writes through native C bindings,
# so the KV process should never run as root. Port 3000 is unprivileged and
# /app/data is the only writable path needed.
RUN groupadd --system lmdis \
  && useradd --system --no-create-home --gid lmdis lmdis \
  && mkdir -p /app/data \
  && chown lmdis:lmdis /app /app/data
USER lmdis
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD bun -e "const r = await fetch('http://localhost:3000/health'); process.exit(r.ok ? 0 : 1)" || exit 1
CMD ["bun", "run", "src/index.ts"]
