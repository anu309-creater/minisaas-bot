FROM node:20-alpine

# Install dependencies for Baileys (if needed for some architectures, optional but good for safety)
# RUN apk add --no-cache git python3 make g++

WORKDIR /app

# Copy package files first for better caching
COPY package*.json ./

# Install dependencies
RUN npm install --production

# Copy the rest of the application
COPY . .

# Create volume directories for persistence
RUN mkdir -p auth_info && chown -R node:node auth_info
RUN echo "{}" > settings.json && chown node:node settings.json

# Switch to non-root user for security
USER node

# Expose port
EXPOSE 3000

# Start command
CMD ["node", "server.js"]
