const { PrismaClient } = require('@prisma/client');
const { env } = require('./env');

/**
 * Prisma Client Singleton
 * Enforces a single instance of PrismaClient across hot-reloads in development 
 * and across serverless invocations, preventing connection exhaustion.
 * MUST rely on DATABASE_URL being a pooled connection (e.g. Neon -pooler.tech).
 */
const globalForPrisma = global;

const prisma =
  globalForPrisma.prisma ||
  new PrismaClient({
    log: env.NODE_ENV === 'development' ? ['query', 'error', 'warn'] : ['error'],
  });

if (env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma;

module.exports = { prisma };
