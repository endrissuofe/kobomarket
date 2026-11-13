// Promote an existing user to admin:  npm run make-admin -- someone@example.com
// The user registers through the API first. The seed script creates its own admin.
const mongo = require('../src/db/mongo');
const { usersRepository } = require('../src/modules/users/users.repository');
const { ROLES } = require('../src/modules/users/user.model');

async function main() {
  const email = process.argv[2];
  if (!email) {
    console.error('Usage: npm run make-admin -- <email>');
    return 1;
  }

  await mongo.connect();
  try {
    const user = await usersRepository.findByEmail(email);
    if (!user) {
      console.error(`No user with email ${email}. Register first.`);
      return 1;
    }
    await usersRepository.addRole(user._id, ROLES.ADMIN);
    const updated = await usersRepository.findById(user._id);
    console.log(`${updated.email} roles: ${updated.roles.join(', ')}`);
    return 0;
  } finally {
    await mongo.close();
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
