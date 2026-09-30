import { migrateDatabase } from "./migrate.js";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("Set DATABASE_URL before running migrations");
await migrateDatabase(connectionString);
console.log("TunnelVision database migrations complete");
