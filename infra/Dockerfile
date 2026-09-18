# ==============================================================================
# Multi-Stage Dockerfile for Amrutam Telemedicine Backend
# Optimized for high security, minimal image size, and non-root execution
# ==============================================================================

# STAGE 1: Builder
FROM node:20-alpine AS builder

WORKDIR /app

# Install build essentials if required by native modules
RUN apk add --no-cache python3 make g++

# Install dependencies based on lockfile
COPY package*.json tsconfig.json ./
RUN npm ci

# Copy source code and Prisma schema
COPY src/ ./src/
COPY docs/ ./docs/

# Build TypeScript to JavaScript
RUN npm run build

# Prune devDependencies to keep runtime lightweight
RUN npm prune --production

# ==============================================================================
# STAGE 2: Production Runner
FROM node:20-alpine AS runner

WORKDIR /app

# Set production environment variables
ENV NODE_ENV=production \
    PORT=3000 \
    HOST=0.0.0.0

# Create unprivileged user for security compliance
RUN addgroup -g 1001 -S amrutam && \
    adduser -u 1001 -S amrutam -G amrutam

# Copy built application and production dependencies from builder stage
COPY --chown=amrutam:amrutam --from=builder /app/package*.json ./
COPY --chown=amrutam:amrutam --from=builder /app/node_modules ./node_modules
COPY --chown=amrutam:amrutam --from=builder /app/dist ./dist
COPY --chown=amrutam:amrutam --from=builder /app/docs ./docs

# Use non-root user
USER amrutam

# Expose HTTP service port
EXPOSE 3000

# Health check using native Node.js HTTP request
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3000/healthz', (res) => { process.exit(res.statusCode === 200 ? 0 : 1); })"

# Default command to run production server
CMD ["node", "dist/server.js"]
