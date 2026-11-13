const config = require('../../config');

// Console mailer. The brief allows logging emails to the console. Emails carry
// one-time tokens, so they are printed with console.log, never through pino
// (structured logs must not hold tokens). In tests they are kept in memory so
// tests can read the token and nothing is printed.
const outbox = [];

async function send({ to, subject, text }) {
  const message = { to, subject, text, sentAt: new Date() };
  if (config.isTest) {
    outbox.push(message);
    return;
  }
  console.log(
    `\n----- EMAIL -----\nTo: ${to}\nSubject: ${subject}\n\n${text}\n-----------------\n`,
  );
}

/** Test helper: the latest message sent to an address. */
function lastMessageTo(to) {
  return [...outbox].reverse().find((m) => m.to === to.toLowerCase());
}

module.exports = { send, outbox, lastMessageTo };
