FROM oven/bun:1
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --production
COPY src/ ./src/
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD bun -e "const r = await fetch('http://localhost:3000/health'); process.exit(r.ok ? 0 : 1)" || exit 1
CMD ["bun", "run", "src/index.ts"]
