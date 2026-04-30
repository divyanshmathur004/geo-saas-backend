const { z } = require('zod');

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.string().default('3000'),
  DATABASE_URL: z.string().url().describe('Pooled connection string for Prisma Client'),
  DIRECT_DATABASE_URL: z.string().url().describe('Direct connection string for Migrations only'),
  REDIS_URL: z.string().url(),
  REDIS_TOKEN: z.string().min(1),
});

const _env = envSchema.safeParse(process.env);

if (!_env.success) {
  console.error('❌ Invalid environment variables:', _env.error.format());
  process.exit(1);
}

module.exports = { env: _env.data };
