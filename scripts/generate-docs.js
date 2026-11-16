// npm run docs:generate: rewrite the generated parts of README.md from the
// real system, so the diagrams cannot drift from the code:
//   - the PostgreSQL ERD (Mermaid), read from the live schema
//   - the MongoDB collections table, read from the Mongoose models
// Each part lives between <!-- name:start --> and <!-- name:end --> markers.
const fs = require('node:fs');
const path = require('node:path');

const postgres = require('../src/db/postgres');
const { mongoose } = require('../src/db/mongo');

const README = path.join(__dirname, '..', 'README.md');
const SKIP_TABLES = new Set(['knex_migrations', 'knex_migrations_lock']);

const TYPE = {
  'timestamp with time zone': 'timestamptz',
  'character varying': 'varchar',
  'double precision': 'float8',
};
const short = (t) => TYPE[t] ?? t;

async function erd() {
  const db = postgres.db;
  const { rows: cols } = await db.raw(`
    SELECT c.table_name, c.column_name, c.data_type, c.is_nullable
      FROM information_schema.columns c
      JOIN information_schema.tables t
        ON t.table_name = c.table_name AND t.table_schema = c.table_schema
     WHERE c.table_schema = 'public' AND t.table_type = 'BASE TABLE'
     ORDER BY c.table_name, c.ordinal_position`);
  const { rows: keys } = await db.raw(`
    SELECT tc.table_name, kcu.column_name, tc.constraint_type
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu
        ON kcu.constraint_name = tc.constraint_name AND kcu.table_schema = tc.table_schema
     WHERE tc.table_schema = 'public' AND tc.constraint_type IN ('PRIMARY KEY', 'FOREIGN KEY', 'UNIQUE')`);
  const { rows: fks } = await db.raw(`
    SELECT tc.table_name AS child, kcu.column_name AS col, ccu.table_name AS parent
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu
        ON kcu.constraint_name = tc.constraint_name AND kcu.table_schema = tc.table_schema
      JOIN information_schema.constraint_column_usage ccu
        ON ccu.constraint_name = tc.constraint_name AND ccu.table_schema = tc.table_schema
     WHERE tc.table_schema = 'public' AND tc.constraint_type = 'FOREIGN KEY'
     ORDER BY child, col`);

  const keyOf = new Map();
  for (const k of keys) {
    const id = `${k.table_name}.${k.column_name}`;
    const tag = { 'PRIMARY KEY': 'PK', 'FOREIGN KEY': 'FK', UNIQUE: 'UK' }[k.constraint_type];
    keyOf.set(id, [...new Set([...(keyOf.get(id) ?? []), tag])]);
  }

  const tables = [...new Set(cols.map((c) => c.table_name))].filter((t) => !SKIP_TABLES.has(t));
  const lines = ['```mermaid', 'erDiagram'];
  for (const fk of fks) {
    if (SKIP_TABLES.has(fk.child)) continue;
    lines.push(`  ${fk.parent} ||--o{ ${fk.child} : "${fk.col}"`);
  }
  for (const table of tables) {
    lines.push(`  ${table} {`);
    for (const c of cols.filter((x) => x.table_name === table)) {
      const tags = (keyOf.get(`${table}.${c.column_name}`) ?? []).join(', ');
      const type = short(c.data_type).replace(/\s+/g, '_');
      lines.push(`    ${type} ${c.column_name}${tags ? ` ${tags}` : ''}`);
    }
    lines.push('  }');
  }
  lines.push('```');
  return lines.join('\n');
}

function collections() {
  // Building the app loads every route module, which compiles every model.
  require('../src/app').createApp();
  const rows = Object.values(mongoose.models)
    .map((model) => {
      const fields = Object.keys(model.schema.paths)
        .filter((p) => !['_id', '__v', 'createdAt', 'updatedAt'].includes(p) && !p.includes('.$'))
        .map((p) => p.split('.')[0])
        .filter((p, i, all) => all.indexOf(p) === i);
      const indexes = model.schema
        .indexes()
        .map(([spec, opts]) => {
          const keysText = Object.entries(spec)
            .map(([k, v]) => (v === 1 ? k : `${k} ${v}`))
            .join(', ');
          const flags = [opts.unique && 'unique', opts.expireAfterSeconds !== undefined && 'TTL']
            .filter(Boolean)
            .join(', ');
          return `\`{ ${keysText} }\`${flags ? ` (${flags})` : ''}`;
        })
        .concat(
          Object.entries(model.schema.paths)
            .filter(([, p]) => p.options?.unique)
            .map(([name]) => `\`{ ${name} }\` (unique)`),
        );
      return `| \`${model.collection.collectionName}\` | ${fields.join(', ')} | ${[...new Set(indexes)].join('<br>') || '—'} |`;
    })
    .sort();
  return ['| Collection | Fields | Indexes |', '| --- | --- | --- |', ...rows].join('\n');
}

function replaceBetween(text, name, body) {
  const start = `<!-- ${name}:start -->`;
  const end = `<!-- ${name}:end -->`;
  const i = text.indexOf(start);
  const j = text.indexOf(end);
  if (i === -1 || j === -1) throw new Error(`README is missing the ${name} markers`);
  return `${text.slice(0, i + start.length)}\n${body}\n${text.slice(j)}`;
}

(async () => {
  try {
    let readme = fs.readFileSync(README, 'utf8');
    readme = replaceBetween(readme, 'erd', await erd());
    readme = replaceBetween(readme, 'collections', collections());
    // Same formatting as the committed file, so an unchanged schema is no diff.
    try {
      const prettier = require('prettier');
      const options = (await prettier.resolveConfig(README)) ?? {};
      readme = await prettier.format(readme, { ...options, filepath: README });
    } catch {
      // prettier is a dev dependency; without it the README is just unformatted
    }
    fs.writeFileSync(README, readme);
    console.log('README.md: ERD and MongoDB collections regenerated');
  } finally {
    await postgres.close();
  }
})().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
