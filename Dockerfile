# Playwright runtime with Chromium already installed
FROM mcr.microsoft.com/playwright:v1.47.2-jammy

WORKDIR /app

# Only install your app deps (Playwright is already in the base image)
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

# Add your server
COPY server.mjs ./

ENV PORT=3000
EXPOSE 3000

# Start your server
CMD ["node", "server.mjs"]
