/**
 * Read-only: how many shops are ready for Google, and why the rest are not.
 * Run on the server:  bun run src/scripts/seo-report.ts
 */
import 'dotenv/config';
import mongoose from 'mongoose';
import { readinessReport } from '@/seo/report';

async function main() {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.error('MONGODB_URI is not set. Run this on the server.');
    process.exit(1);
  }
  await mongoose.connect(uri, process.env.DB_NAME ? { dbName: process.env.DB_NAME } : {});
  console.log(JSON.stringify(await readinessReport(), null, 2));
  await mongoose.disconnect();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
