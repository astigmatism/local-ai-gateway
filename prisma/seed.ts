import 'dotenv/config';
import { ensureAuthBootstrap } from '../server/src/auth/bootstrap.js';
import { prisma } from '../server/src/db/prisma.js';

async function main() {
  await ensureAuthBootstrap();
  const eric = await prisma.user.findFirst({
    where: { displayName: { equals: 'Eric', mode: 'insensitive' } }
  });

  if (eric) {
    console.log(`Verified default admin user: ${eric.displayName} (${eric.id})`);
  }
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
