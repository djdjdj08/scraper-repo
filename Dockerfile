# Use Playwright image that already has Chromium + deps
FROM mcr.microsoft.com/playwright:v1.47.2-jammy

WORKDIR /app

# Install only your app deps (Playwright is in the base image)
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

# Add your server
COPY server.mjs ./

ENV PORT=3000
EXPOSE 3000

CMD ["node", "server.mjs"]
