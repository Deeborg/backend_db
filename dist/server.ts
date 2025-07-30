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
  password: process.env.DB_PASSWORD || 'password1A',
  port: Number(process.env.DB_PORT) || 5432,
});

// --- TABLE NAME for journal update APIs ---
const TABLE_NAME = process.env.JOURNAL_TABLE || 'adjustment_entries'; 

/**
 * @route POST /api/data
 * @desc  Insert mappedData and transformedData into PostgreSQL
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
        newRow[key] = key === 'glAccount' ? row[key] : 0;
      }
    });
    return newRow;
  });

  try {
    // 1. Create and insert into trial_balance
    const firstRowOriginal = mappedData[0];
    const originalColumns = Object.keys(firstRowOriginal);
    const originalColumnDefs = originalColumns.map(col => `"${col}" TEXT`);
    const createOriginalTableSQL = `
      CREATE TABLE IF NOT EXISTS trial_balance (
        id SERIAL PRIMARY KEY,
        ${originalColumnDefs.join(',\n      ')}
      );
    `;
    await pool.query(createOriginalTableSQL);

    for (const row of mappedData) {
      const rowColumns = Object.keys(row);
      const values = Object.values(row);
      const colNames = rowColumns.map(col => `"${col}"`).join(', ');
      const paramPlaceholders = rowColumns.map((_, i) => `$${i + 1}`).join(', ');
      const sql = `INSERT INTO trial_balance (${colNames}) VALUES (${paramPlaceholders})`;
      await pool.query(sql, values);
    }

    // 2. Create and insert into adjustment_entries
    const firstRowTransformed = transformedData[0];
    const transformedColumns = Object.keys(firstRowTransformed);
    const transformedColumnDefs = transformedColumns.map(col => `"${col}" TEXT`);
    const createTransformedTableSQL = `
      CREATE TABLE IF NOT EXISTS adjustment_entries (
        id SERIAL PRIMARY KEY,
        ${transformedColumnDefs.join(',\n      ')}
      );
    `;
    await pool.query(createTransformedTableSQL);

    for (const row of transformedData) {
      const rowColumns = Object.keys(row);
      const values = Object.values(row);
      const colNames = rowColumns.map(col => `"${col}"`).join(', ');
      const paramPlaceholders = rowColumns.map((_, i) => `$${i + 1}`).join(', ');
      const sql = `INSERT INTO adjustment_entries (${colNames}) VALUES (${paramPlaceholders})`;
      await pool.query(sql, values);
    }

    res.status(200).send('Both mappedData and transformedData inserted successfully');
  } catch (error) {
    console.error(error);
    res.status(500).send('Error inserting data');
  }
});

/**
 * @route GET /api/journal/metadata
 * @desc  Get GL accounts and period column headers
 */
app.get('/api/journal/metadata', async (req, res) => {
  try {
    const glAccountsResult = await pool.query(
      `SELECT DISTINCT "glAccount" FROM ${TABLE_NAME} ORDER BY "glAccount"`
    );
    const glAccounts = glAccountsResult.rows.map(row => row.glAccount);

    const columnsResult = await pool.query(
      `
      SELECT column_name 
      FROM information_schema.columns 
      WHERE table_name = $1 AND column_name != 'glAccount'
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
 * @route POST /api/journal/update
 * @desc  Update a specific cell in the journal table
 */
app.post('/api/journal/update', async (req, res) => {
  const { glAccount, period, value } = req.body;

  if (!glAccount || !period || value === undefined) {
    return res.status(400).json({ msg: 'Please provide glAccount, period, and value' });
  }

  try {
    const updateQuery = `
      UPDATE ${TABLE_NAME} 
      SET "${period}" = $1 
      WHERE "glAccount" = $2
    `;
    await pool.query(updateQuery, [value, glAccount]);
    res.json({ msg: 'Journal entry updated successfully' });
  } catch (err: any) {
    console.error(err.message);
    res.status(500).send('Server Error');
  }
});

// Start server
app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
