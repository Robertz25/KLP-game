// Quick CLI tool to view rows saved by the post-game contact form.
// Usage (PowerShell):
//   $env:DATABASE_URL="<paste External Database URL from Render>"; node scripts/view-contacts.js
const { Pool } = require('pg');

const databaseUrl = (process.env.DATABASE_URL || '').trim();
if (!databaseUrl) {
    console.error('Set DATABASE_URL first, e.g.:\n  $env:DATABASE_URL="postgresql://user:pass@host/dbname"; node scripts/view-contacts.js');
    process.exit(1);
}

const pool = new Pool({ connectionString: databaseUrl, ssl: { rejectUnauthorized: false } });

(async () => {
    try {
        const { rows } = await pool.query('SELECT id, name, phone, score, room, created_at FROM contacts ORDER BY created_at DESC');
        if (!rows.length) {
            console.log('No contacts saved yet.');
        } else {
            console.table(rows);
        }
    } catch (err) {
        console.error('Query failed:', err.message);
        process.exitCode = 1;
    } finally {
        await pool.end();
    }
})();
