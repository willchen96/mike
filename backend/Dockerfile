# Stage 1: Builder
FROM node:20-bookworm-slim AS builder

WORKDIR /app

# Copy package files
COPY package.json package-lock.json ./

# Install dependencies
RUN npm ci

# Copy source code
COPY src/ ./src/
COPY tsconfig.json ./

# Build TypeScript
RUN npm run build

# Stage 2: Runtime
FROM node:20-bookworm-slim

WORKDIR /app

# Install LibreOffice for DOC/DOCX to PDF conversion
RUN apt-get update && \
    apt-get install -y libreoffice --no-install-recommends && \
    rm -rf /var/lib/apt/lists/*

# Set environment to production
ENV NODE_ENV=production

# Copy built application from builder
COPY --from=builder /app/dist ./dist

# Copy package files and install production dependencies only
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Expose port
EXPOSE 3001

# Start application
CMD ["node", "dist/index.js"]
