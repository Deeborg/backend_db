import express from 'express';
import cors from 'cors';
import bodyParser from 'body-parser';
import { Pool } from 'pg';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
const PORT = process.env.API_PORT || 5000;

app.use(cors());
app.use(bodyParser.json({ limit: '100mb' }));
app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ limit: '100mb', extended: true }));

// --- PostgreSQL Connection Pool ---
const pool = new Pool({
  user: process.env.DB_USER || 'postgres',
  host: process.env.DB_HOST || 'localhost',
  database: process.env.DB_DATABASE || 'Y_Finance',
  password: process.env.DB_PASSWORD || 'root',
  port: Number(process.env.DB_PORT) || 5432,
});

// --- TABLE NAME for journal update APIs ---
const TABLE_NAME = process.env.JOURNAL_TABLE || 'adjustment_entries';

/**
 * Ensures that a table exists with "glAccount" as primary key
 */
async function ensureTable(tableName: string, sampleRow: Record<string, any>) {
  const existingColumnsResult = await pool.query(
    `SELECT column_name FROM information_schema.columns WHERE table_name = $1`,
    [tableName]
  );
  const existingColumns = existingColumnsResult.rows.map(r => r.column_name);

  // Determine primary key column
  const primaryKey = tableName === 'financial_variables1' ? 'key' : 'glAccount';

  // Create table if it doesn't exist
  if (existingColumns.length === 0) {
    const columnDefs = Object.keys(sampleRow)
      .filter(col => col !== primaryKey)
      .map(col => `"${col}" TEXT`);

    const createTableSQL = `
      CREATE TABLE IF NOT EXISTS "${tableName}" (
        "${primaryKey}" TEXT PRIMARY KEY,
        ${columnDefs.join(',\n        ')}
      );
    `;
    await pool.query(createTableSQL);
  } else {
    // Add any missing columns dynamically
    for (const col of Object.keys(sampleRow)) {
      if (!existingColumns.includes(col)) {
        await pool.query(`ALTER TABLE "${tableName}" ADD COLUMN "${col}" TEXT`);
      }
    }
  }
}


/**
 * Inserts or updates rows using ON CONFLICT (upsert)
 */
async function upsertRows(tableName: string, rows: Record<string, any>[]) {
  for (const row of rows) {
    const columns = Object.keys(row);
    const values = Object.values(row);

    const colNames = columns.map(col => `"${col}"`).join(', ');
    const paramPlaceholders = columns.map((_, i) => `$${i + 1}`).join(', ');

    const updateAssignments = columns
      .filter(col => col !== 'glAccount')
      .map(col => `"${col}" = EXCLUDED."${col}"`)
      .join(', ');

    const sql = `
      INSERT INTO ${tableName} (${colNames})
      VALUES (${paramPlaceholders})
      ON CONFLICT ("glAccount")
      DO UPDATE SET ${updateAssignments};
    `;
    await pool.query(sql, values);
  }
}

async function upsertRowsWithKey(tableName: string, rows: Record<string, any>[]) {
  for (const row of rows) {
    const columns = Object.keys(row);
    const values = Object.values(row);

    const colNames = columns.map(col => `"${col}"`).join(', ');
    const paramPlaceholders = columns.map((_, i) => `$${i + 1}`).join(', ');

    const updateAssignments = columns
      .filter(col => col !== 'key')
      .map(col => `"${col}" = EXCLUDED."${col}"`)
      .join(', ');

    const sql = `
      INSERT INTO ${tableName} (${colNames})
      VALUES (${paramPlaceholders})
      ON CONFLICT ("key")
      DO UPDATE SET ${updateAssignments};
    `;

    await pool.query(sql, values); // ✅ CORRECT
  }
}

/**
 * @route POST /api/data
 * @desc  Insert mappedData and transformedData into PostgreSQL with upsert
 */
app.post('/api/data', async (req, res) => {
  const { mappedData } = req.body as { mappedData: Record<string, any>[] };

  if (!mappedData || mappedData.length === 0) {
    return res.status(400).send('No data received');
  }

  const exclude = ['createdby', 'accountType', 'Level 1 Desc', 'Level 2 Desc', 'functionalArea'];

  // Transform data
  const transformedData = mappedData.map((row: Record<string, any>) => {
    const newRow: Record<string, any> = {};
    Object.keys(row).forEach((key) => {
      if (!exclude.includes(key)) {
        if (key === 'glAccount' || key === 'glName') {
          newRow[key] = row[key];
        } else {
          newRow[key] = 0;
        }
      }
    });
    return newRow;
  });

  try {
    // Ensure tables exist and have correct structure
    await ensureTable('trial_balance', mappedData[0]);
    await ensureTable('adjustment_entries', transformedData[0]);

    // Insert or update data
    await upsertRows('trial_balance', mappedData);
    await upsertRows('adjustment_entries', transformedData);

    res.status(200).send('Both mappedData and transformedData inserted/updated successfully');
  } catch (error) {
    console.error(error);
    res.status(500).send('Error inserting/updating data');
  }
});

app.post('/api/financialvar-updated', async (req, res) => {
  const { financialVar1 } = req.body as { financialVar1: Record<string, any>[] };

  if (!financialVar1 || financialVar1.length === 0) {
    return res.status(400).send('No data received');
  }
  try {
    // Ensure tables exist and have correct structure
    await ensureTable('financial_variables1', financialVar1[0]);
    
    
    await upsertRowsWithKey('financial_variables1', financialVar1);

    res.status(200).send('financialVar inserted/updated successfully');
  } catch (error) {
    console.error(error);
    res.status(500).send('Error inserting/updating data');
  }
});

/**
 * @route GET /api/journal/metadata
 * @desc  Get GL accounts and period column headers
 */
app.get('/api/journal/metadata', async (req, res) => {
  try {
    const glAccountsResult = await pool.query(
      `SELECT DISTINCT "glAccount", "glName" FROM ${TABLE_NAME} ORDER BY "glAccount"`
    );
    const glAccounts = glAccountsResult.rows;

    const columnsResult = await pool.query(
      `
      SELECT column_name 
      FROM information_schema.columns 
      WHERE table_name = $1 AND column_name NOT IN ('glAccount', 'glName')
      `,
      [TABLE_NAME]
    );
    const periods = columnsResult.rows.map(row => row.column_name);

    res.json({ glAccounts, periods });
  } catch (err: any) {
    console.error(err.message);
    res.status(500).send('Server Error');
  }
});

/**
 * @route POST /api/journal/batch-update
 * @desc Updates multiple journal entries in a single transaction
 */
app.post('/api/journal/batch-update', async (req, res) => {
  const entries = req.body; // Expects an array: [{ glAccount, period, value }, ...]

  if (!Array.isArray(entries) || entries.length === 0) {
    return res.status(400).json({ msg: 'Invalid request body. Expected an array of entries.' });
  }

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const updatePromises = entries.map(entry => {
      const { glAccount, period, value } = entry;
      const updateQuery = `
        UPDATE ${TABLE_NAME} 
        SET "${period}" = $1 
        WHERE "glAccount" = $2
      `;
      if (glAccount && period && value !== undefined) {
        return client.query(updateQuery, [value, glAccount]);
      }
      return Promise.resolve();
    });

    await Promise.all(updatePromises);

    await client.query('COMMIT');
    res.json({ msg: 'Journal entries posted successfully' });
  } catch (err: any) {
    await client.query('ROLLBACK');
    console.error('Transaction failed:', err.message);
    res.status(500).send('Server Error during transaction');
  } finally {
    client.release();
  }
});

app.get('/api/journal/updated', async (req, res) => {
    try {
        const glAccountsupdated = await pool.query('SELECT * FROM adjustment_entries');
        const updatedglAccounts = glAccountsupdated.rows; // Get all rows directly
        res.json(updatedglAccounts); // Send all data as JSON
    } catch (err:any) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
});

app.get('/api/financial_variables', async (req, res) => {
    try {
        const glAccountsupdated = await pool.query('SELECT * FROM financial_variables');
        const updatedglAccounts = glAccountsupdated.rows; // Get all rows directly
        res.json(updatedglAccounts); // Send all data as JSON
    } catch (err:any) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
});


// Start server
app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
