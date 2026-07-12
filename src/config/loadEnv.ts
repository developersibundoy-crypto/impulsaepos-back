import fs from "fs";
import path from "path";
import dotenv from "dotenv";

const nodeEnv = process.env.NODE_ENV?.trim();
const envName = nodeEnv && nodeEnv.length > 0 ? nodeEnv : "development";

const envFiles = [
  `.env.${envName}.local`,
  `.env.${envName}`,
  ".env.local",
  ".env",
];

for (const envFile of envFiles) {
  const fullPath = path.resolve(process.cwd(), envFile);
  if (fs.existsSync(fullPath)) {
    dotenv.config({ path: fullPath, override: false });
  }
}
