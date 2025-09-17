# Dockerfile - Node 18 + Ookla Speedtest CLI installed via official .deb
FROM node:18-slim

ENV DEBIAN_FRONTEND=noninteractive

# Install required utilities
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
     curl ca-certificates gnupg apt-transport-https \
  && rm -rf /var/lib/apt/lists/*

# Download & install Ookla Speedtest CLI .deb (pinned version)
# If this URL breaks in future, tell me and I'll fetch the latest .deb link.
RUN curl -sLo /tmp/speedtest.deb https://install.speedtest.net/app/cli/ookla-speedtest-1.2.0-linux-x86_64.deb \
  && dpkg -i /tmp/speedtest.deb || (apt-get update && apt-get install -y -f) \
  && rm -f /tmp/speedtest.deb

# App directory
WORKDIR /app

# Copy package files and install deps (cached layer)
COPY package*.json ./
RUN npm ci --only=production || npm install --production

# Copy source
COPY . .

# Helpful: reduce image size by cleaning apt cache (already done above) and expose port
EXPOSE 8080

# Start the app
CMD ["npm", "start"]
