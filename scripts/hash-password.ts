import { hashPassword } from "../src/server/auth/password-service";

const password = process.argv[2];

async function main(): Promise<void> {
  if (!password) {
    console.error("Usage: npm run auth:hash-password -- \"PASSWORD\"");
    process.exit(1);
  }

  const hash = await hashPassword(password);
  console.log(hash);
}

void main();
