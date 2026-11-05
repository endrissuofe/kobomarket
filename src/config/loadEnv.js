const dotenv = require('dotenv');

// Load env files once. .env.local (written by `neon deploy` / `neon env pull`)
// wins over .env. Values already in process.env (Docker env_file, CI) win over both.
dotenv.config({ path: ['.env.local', '.env'], quiet: true });
