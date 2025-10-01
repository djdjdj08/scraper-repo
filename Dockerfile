# Use the official Playwright image that already includes Chromium & system deps
FROM mcr.microsoft.com/playwright:v1.55.1-jammy

# Recommended envs
ENV NODE_ENV=production \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

# All work happens in /app
WORKDIR /app

# Install only your app deps (Playwright is already in the base image)
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev --no-audit --no-fund

# Add your server
COPY server.mjs ./

# Expose the port your Express app listens on
EXPOSE 3000

# Start the server
CMD ["node", "server.mjs"]
