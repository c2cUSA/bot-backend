// backend/src/config-check.ts

import dotenv from 'dotenv';

dotenv.config();

export function validateConfig() {
  const requiredEnvVars = [
    'DB_HOST',
    'DB_PORT',
    'DB_USER',
    'DB_PASS',
    'DB_NAME',
    'JWT_SECRET',
    'C2SD_MINT',
    'USDC_MINT',
    'RPC_URL',
    'HEALTH_CHECK_INTERVAL',
    'TOTAL_TRADES',
    'MAX_CONSECUTIVE_FAILURES'
  ];

  const missingVars = requiredEnvVars.filter(key => !process.env[key]);

  if (missingVars.length > 0) {
    throw new Error(`Missing required environment variables: ${missingVars.join(', ')}`);
  }

  // Optional: Validate integer types
  const numberVars = ['HEALTH_CHECK_INTERVAL', 'TOTAL_TRADES', 'MAX_CONSECUTIVE_FAILURES'];
  numberVars.forEach(key => {
    if (isNaN(Number(process.env[key]))) {
      throw new Error(`Environment variable ${key} must be a valid number.`);
    }
  });

  console.log('[ConfigCheck] All required environment variables are valid.');
}
