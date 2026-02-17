FROM node:20-alpine

# Install dependencies for Baileys (if needed for some architectures, optional but good for safety)
# RUN apk add --no-cache git python3 make g++

WORKDIR /app

# Copy package files first for better caching
COPY package*.json ./

# Install dependencies
RUN npm install --production

# Copy the rest of the application
# Copy the rest of the application with correct permissions
COPY --chown=node:node . .

# Create volume directories for persistence (optional but good practice)
RUN mkdir -p auth_info_live && chown -R node:node /app

# Switch to non-root user for security
USER node

# Expose port
EXPOSE 3000

# Start command
CMD ["node", "server.js"]
