import express, { Request, Response } from 'express';
import cors from 'cors';
import bodyParser from 'body-parser';
import { Pool } from 'pg';
import dotenv from 'dotenv';
import crypto from 'crypto';
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


const TABLE_NAME = process.env.JOURNAL_TABLE || 'adjustment_entries';


export async function ensureTable(
  tableName: string,
  sampleRow: Record<string, any>,
  overwrite: boolean = false,
  renameMap: Record<string, string> = {}
): Promise<string[]> {
  const existingColumnsResult = await pool.query(
    `SELECT column_name FROM information_schema.columns WHERE table_name = $1`,
    [tableName]
  );
  const existingColumns = existingColumnsResult.rows.map((r) => r.column_name);
  console.log(`Existing columns in ${tableName}:`, existingColumns); // Debug log

  let primaryKey: string;
  let excludeFromDynamicManagement: string[] = [];

  if (tableName === "financial_variables1" || tableName === "text_keys1") {
    primaryKey = "key";
  } else if (tableName === "trial_balance" || tableName === "adjustment_entries") {
    primaryKey = "glAccount";
    excludeFromDynamicManagement = [
      "glName",
      "accountType",
      "Level 1 Desc",
      "Level 2 Desc",
      "functionalArea",
    ];
  } else {
    throw new Error(`ensureTable: Unknown table name provided: ${tableName}`);
  }

  const duplicates: string[] = [];

  if (existingColumns.length === 0) {
    const columnDefs = Object.keys(sampleRow)
      .filter((col) => col !== primaryKey)
      .map((col) => `"${col}" TEXT`);
    const createTableSQL = `
      CREATE TABLE IF NOT EXISTS "${tableName}" (
        "${primaryKey}" TEXT PRIMARY KEY,
        ${columnDefs.join(",\n        ")}
      );
    `;
    console.log(`Creating table ${tableName} with SQL:`, createTableSQL); // Debug log
    await pool.query(createTableSQL);
  } else {
    for (const col of Object.keys(sampleRow)) {
      if (col === primaryKey || excludeFromDynamicManagement.includes(col)) continue;

      if (!existingColumns.includes(col)) {
        console.log(`Adding new column ${col} to ${tableName}`); // Debug log
        await pool.query(`ALTER TABLE "${tableName}" ADD COLUMN "${col}" TEXT`);
      } else if (overwrite) {

        if (tableName === 'trial_balance') {
          console.log(`Delete rows ${col} from adj_entry_list`);
          // Example: Delete rows from adj_entry_list where period matches column name
          await pool.query(`DELETE FROM adj_entry_list WHERE period = '${col}'`);
        }


        console.log(`Dropping column ${col} from ${tableName}`); // Debug log
        await pool.query(`ALTER TABLE "${tableName}" DROP COLUMN IF EXISTS "${col}"`);
        console.log(`Re-adding column ${col} to ${tableName}`); // Debug log
        await pool.query(`ALTER TABLE "${tableName}" ADD COLUMN "${col}" TEXT`);
      } else {
        console.log(`Duplicate column ${col} found in ${tableName}`); // Debug log
        duplicates.push(col);
      }
    }
  }
  return duplicates;
}

/**
 * Ensures adj_entry_list table exists
 */
async function ensureAdjEntryTable() {
  const createTableSQL = `
    CREATE TABLE IF NOT EXISTS adj_entry_list (
      id SERIAL PRIMARY KEY,
      hash_val TEXT NOT NULL,
      "glAccount" TEXT NOT NULL,
      "glName" TEXT NOT NULL,
      "period" TEXT NOT NULL,
      "amount" NUMERIC NOT NULL,
      "narration" TEXT,
      "status" TEXT DEFAULT 'pending',
      "entry_type" TEXT DEFAULT 'manual',
      "created_at" TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      "approved_at" TIMESTAMP NULL,
      "approved_by" TEXT NULL,
      "admin_comments" TEXT NULL
    );
  `;
  await pool.query(createTableSQL);
}
ensureAdjEntryTable().catch(console.error);

/**
 * Upsert for glAccount based tables
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

/**
 * Upsert for financial_variables1
 */
async function upsertRowsWithKey(tableName: string, rows: Record<string, any>[]) {
  for (const row of rows) {
    const columns = Object.keys(row);
    const values = Object.values(row);

    const colNames = columns.map(col => `"${col}"`).join(', ');
    const paramPlaceholders = columns.map((_, i) => `$${i + 1}`).join(', ');

    const updateAssignments = columns
      .filter(col => col !== 'key')
      .map(col =>
        `"${col}" = COALESCE(${tableName}."${col}", EXCLUDED."${col}")`
      )
      .join(', ');

    const sql = `
      INSERT INTO ${tableName} (${colNames})
      VALUES (${paramPlaceholders})
      ON CONFLICT ("key")
      DO UPDATE SET ${updateAssignments};
    `;

    await pool.query(sql, values);
  }
}

/**
 * @route POST /api/data
 * @desc  Insert mappedData and transformedData into PostgreSQL with upsert
 */
app.post("/api/data", async (req: Request, res: Response) => {
  const { finalMappedData, overwrite } = req.body as {
    finalMappedData: Record<string, any>[];
    overwrite?: boolean;
  };
  console.log("Received overwrite flag:", overwrite);
  if (!finalMappedData || finalMappedData.length === 0) {
    return res.status(400).send('No data received');
  }

  const exclude = ['accountType', 'Level 1 Desc', 'Level 2 Desc', 'functionalArea'];

  const transformedData = finalMappedData.map((row: Record<string, any>) => {
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
    const trialBalanceDuplicates = await ensureTable(
      "trial_balance",
      finalMappedData[0],
      overwrite ?? false
    );

    const adjustmentEntriesDuplicates = await ensureTable(
      "adjustment_entries",
      transformedData[0],
      overwrite ?? false
    );
    const allDuplicates: { trial_balance?: string[]; adjustment_entries?: string[] } = {};
    if (trialBalanceDuplicates.length > 0) {
      allDuplicates.trial_balance = trialBalanceDuplicates;
    }
    if (adjustmentEntriesDuplicates.length > 0) {
      allDuplicates.adjustment_entries = adjustmentEntriesDuplicates;
    }

    if (Object.keys(allDuplicates).length > 0 && !(overwrite ?? false)) {
      return res.status(409).json({
        msg: "Duplicate columns found and overwrite not requested.",
        duplicates: allDuplicates,
      });
    }
    await upsertRows('trial_balance', finalMappedData);
    await upsertRows('adjustment_entries', transformedData);
    res.status(200).send('Both mappedData and transformedData inserted/updated successfully');
  } catch (error) {
    console.error(error);
    res.status(500).send('Error inserting/updating data');
  }
});

/**
 * @route POST /api/financialvar-updated
 */
app.post('/api/financialvar-updated', async (req, res) => {
  const { financialVar1, overwrite } = req.body as {
    financialVar1: Record<string, any>[];
    overwrite?: boolean;
  };

  if (!financialVar1 || financialVar1.length === 0) {
    return res.status(400).send('No data received');
  }
  try {
    await ensureTable('financial_variables1', financialVar1[0], overwrite ?? false);
    await upsertRowsWithKey('financial_variables1', financialVar1);
    res.status(200).send('financialVar inserted/updated successfully');
  } catch (error) {
    console.error(error);
    res.status(500).send('Error inserting/updating data');
  }
});

app.post('/api/text-variables', async (req, res) => {
  const { textVar1, overwrite } = req.body as {
    textVar1: Record<string, any>[];
    overwrite?: boolean;
  };

  if (!textVar1 || textVar1.length === 0) {
    return res.status(400).send('No data received');
  }
  try {
    await ensureTable('text_keys1', textVar1[0], overwrite ?? false);
    await upsertRowsWithKey('text_keys1', textVar1);
    res.status(200).send('textVar inserted/updated successfully');
  } catch (error) {
    console.error(error);
    res.status(500).send('Error inserting/updating data');
  }
});
/**
 * @route GET /api/journal/metadata
 * @desc  Get GL accounts and period column headers
 */
app.get('/api/data', async (req, res) => {
 try {
    const data = await pool.query(`SELECT DISTINCT "glAccount", "glName","Level 1 Desc","Level 2 Desc" FROM trial_balance ORDER BY "glAccount"`);
    const data1 = data.rows; // Get all rows directly
    res.json(data1); // Send all data as JSON
  } catch (err: any) {
    console.error(err.message);
    res.status(500).send('Server Error');
  }
});
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
  const { entries, narration } = req.body;
  if (!Array.isArray(entries) || entries.length === 0) {
    return res.status(400).json({ msg: 'Invalid request body. Expected an array of entries.' });
  }
  const narrationText = typeof narration === 'string' && narration.trim() !== ''
    ? narration.trim()
    : 'No narration provided';
  const client = await pool.connect();
  const hashVal = crypto.randomBytes(8).toString('hex');

  try {
    await client.query('BEGIN');

    for (const entry of entries) {
      const { glAccount, period, value } = entry;
      if (!glAccount || !period || value === undefined) continue;

      const glRes = await client.query(
        `SELECT "glName" FROM ${TABLE_NAME} WHERE "glAccount" = $1`,
        [glAccount]
      );
      const glName = glRes.rows[0]?.glName || '';

      await client.query(
        `INSERT INTO adj_entry_list (hash_val, "glAccount", "glName", "period", "amount", "status", "entry_type","narration") 
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [hashVal, glAccount, glName, period, value, 'pending', 'manual', narrationText]
      );
    }

    await client.query('COMMIT');
    res.json({ msg: 'Journal entries posted successfully', hashVal });
  } catch (err: any) {
    await client.query('ROLLBACK');
    console.error('Transaction failed:', err.message);
    res.status(500).send('Server Error during transaction');
  } finally {
    client.release();
  }
});
// Reject entries
app.post('/api/journal/reject-entries', async (req, res) => {
  const { entryIds, rejectedBy = 'admin',narration } = req.body;
  const narrationText = typeof narration === 'string' && narration.trim() !== ''
    ? narration.trim()
    : 'No narration provided';

  if (!Array.isArray(entryIds) || entryIds.length === 0) {
    return res.status(400).json({ msg: 'Invalid request body. Expected an array of entry IDs.' });
  }

  try {
    const placeholders = entryIds.map((_, i) => `$${i + 3}`).join(',');
    const result = await pool.query(
      `UPDATE adj_entry_list 
       SET "status" = 'rejected', "approved_at" = CURRENT_TIMESTAMP, "approved_by" = $1, "admin_comments" = $2
       WHERE id IN (${placeholders}) AND "status" = 'pending'`,
      [rejectedBy,narrationText, ...entryIds]
    );

    res.json({
      msg: 'Entries rejected successfully',
      rejectedCount: result.rowCount
    });
  } catch (err: any) {
    console.error('Rejection failed:', err.message);
    res.status(500).send('Server Error during rejection process');
  }
});

app.post('/api/journal/approve-entries', async (req: Request, res: Response) => {
  const { entryIds, approvedBy = 'admin', narration } = req.body;
  const narrationText = typeof narration === 'string' && narration.trim() !== ''
    ? narration.trim()
    : 'No narration provided';

  if (!Array.isArray(entryIds) || entryIds.length === 0) {
    return res.status(400).json({ msg: 'Invalid request body. Expected an array of entry IDs.' });
  }

  try {
    // Step 1: Approve entries
    const placeholders = entryIds.map((_, i) => `$${i + 3}`).join(',');
    const approveResult = await pool.query(
      `UPDATE adj_entry_list 
       SET "status" = 'approved', "approved_at" = CURRENT_TIMESTAMP, "approved_by" = $1, "admin_comments" = $2
       WHERE id IN (${placeholders})`,
      [approvedBy,narrationText, ...entryIds]
    );

    // Step 2: Get distinct periods from approved entries
    const periodsResult = await pool.query(
      `SELECT DISTINCT period 
       FROM adj_entry_list
       WHERE id = ANY($1::int[]) AND status = 'approved'`,
      [entryIds]
    );

    const periods = periodsResult.rows.map((r: any) => r.period);

    if (periods.length > 0) {
      // Step 3: Build dynamic insert/update query for adjustment_entries
      const insertCols = ['"glAccount"', '"glName"', ...periods.map(p => `"${p}"`)];
      const selectCols = [
        '"glAccount"',
        '"glName"',
        ...periods.map(p => `SUM(CASE WHEN period = '${p}' THEN amount ELSE 0 END) AS "${p}"`)
      ];
      const updateCols = periods.map(p => `"${p}" = EXCLUDED."${p}"`);

      const dynamicQuery = `
        INSERT INTO adjustment_entries (${insertCols.join(', ')})
        SELECT ${selectCols.join(', ')}
        FROM adj_entry_list
        WHERE id = ANY($1::int[]) AND status = 'approved'
        GROUP BY "glAccount", "glName"
        ON CONFLICT ("glAccount") DO UPDATE
        SET ${updateCols.join(', ')};
      `;

      await pool.query(dynamicQuery, [entryIds]);
    }

    res.json({
      msg: 'Entries approved and adjustment_entries updated successfully',
      approvedCount: approveResult.rowCount
    });
  } catch (err: any) {
    console.error('Approve failed:', err.message);
    res.status(500).send('Server Error during approval process');
  }
});

// Get all pending entries for admin approval
app.get('/api/journal/pending-entries', async (req, res) => {
  try {
    const entriesResult = await pool.query(
      `SELECT id, hash_val, "glAccount", "glName", "period", "amount", "entry_type", "created_at","narration"
       FROM adj_entry_list 
       WHERE "status" = 'pending' 
       ORDER BY "created_at" DESC, hash_val`
    );
    res.json({ entries: entriesResult.rows });
  } catch (err: any) {
    console.error(err.message);
    res.status(500).send('Server Error while fetching pending entries');
  }
});
/**
 * @route GET /api/journal/entries
 */
app.get('/api/journal/entries', async (req, res) => {
  try {
    const { period } = req.query;

    if (!period) {
      const periodsResult = await pool.query(`SELECT DISTINCT "period" FROM adj_entry_list ORDER BY "period"`);
      return res.json({ periods: periodsResult.rows.map(r => r.period) });
    }

    const entriesResult = await pool.query(
      `SELECT hash_val, "glAccount", "glName", "period", "amount","narration"
       FROM adj_entry_list 
       WHERE "period" = $1 
       ORDER BY hash_val`,
      [period]
    );

    res.json({ entries: entriesResult.rows });
  } catch (err: any) {
    console.error(err.message);
    res.status(500).send('Server Error while fetching entries');
  }
});

app.get('/api/journal/updated', async (req, res) => {
  try {
    const glAccountsupdated = await pool.query('SELECT * FROM adjustment_entries');
    res.json(glAccountsupdated.rows);
  } catch (err: any) {
    console.error(err.message);
    res.status(500).send('Server Error');
  }
});

app.post('/api/update-financial-vars', async (req, res) => {
  try {
    const dataArray = Array.isArray(req.body) ? req.body : [req.body];

    for (const row of dataArray) {
      const { key, ...columnsToUpdate } = row;

      if (!key || Object.keys(columnsToUpdate).length === 0) continue;

      const setClauses = Object.keys(columnsToUpdate)
        .map((col, i) => `"${col}" = $${i + 2}`)
        .join(', ');

      const values = [key, ...Object.values(columnsToUpdate)];

      const query = `
        UPDATE financial_variables1
        SET ${setClauses}
        WHERE key = $1
      `;

      await pool.query(query, values);
    }

    res.status(200).json({ message: 'Update successful' });
  } catch (error) {
    console.error('Error updating:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/update-text-vars', async (req, res) => {
  try {
    const dataArray = Array.isArray(req.body) ? req.body : [req.body];

    for (const row of dataArray) {
      const { key, ...columnsToUpdate } = row;

      if (!key || Object.keys(columnsToUpdate).length === 0) continue;

      const setClauses = Object.keys(columnsToUpdate)
        .map((col, i) => `"${col}" = $${i + 2}`)
        .join(', ');

      const values = [key, ...Object.values(columnsToUpdate)];

      const query = `
        UPDATE text_keys1
        SET ${setClauses}
        WHERE key = $1
      `;

      await pool.query(query, values);
    }

    res.status(200).json({ message: 'Update successful' });
  } catch (error) {
    console.error('Error updating:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/text_keys1', async (req, res) => {
  try {
    const updatedtext_keys = await pool.query('SELECT * FROM text_keys1');
    const updatedtext_keys1 = updatedtext_keys.rows; // Get all rows directly
    res.json(updatedtext_keys1); // Send all data as JSON
  } catch (err: any) {
    console.error(err.message);
    res.status(500).send('Server Error');
  }
});

/**
 * @route GET /api/trial-balance/periods
 * @desc Get available periods from trial_balance table
 */
app.get('/api/trial-balance/periods', async (req, res) => {
  try {
    const columnsResult = await pool.query(`
      SELECT column_name 
      FROM information_schema.columns 
      WHERE table_name = 'trial_balance' 
      AND column_name NOT IN ('glAccount', 'glName', 'accountType', 'Level 1 Desc', 'Level 2 Desc', 'functionalArea')
      ORDER BY column_name
    `);

    const periods = columnsResult.rows.map(row => row.column_name);
    res.json({ periods });
  } catch (err: any) {
    console.error(err.message);
    res.status(500).send('Server Error');
  }
});

/**
 * @route GET /api/trial-balance/data
 * @desc Get trial balance data for selected periods
 */
app.get('/api/trial-balance/data', async (req, res) => {
  try {
    const { period1, period2 } = req.query;

    if (!period1 || !period2) {
      return res.status(400).json({ error: 'Both period1 and period2 are required' });
    }

    const query = `
      SELECT 
        "glAccount",
        "glName", 
        "accountType",
        "Level 1 Desc",
        "Level 2 Desc",
        "functionalArea",
        "${period1}" as "amountCurrent",
        "${period2}" as "amountPrevious"
      FROM trial_balance 
      ORDER BY "glAccount"
    `;

    const result = await pool.query(query);
    res.json(result.rows);
  } catch (err: any) {
    console.error(err.message);
    res.status(500).send('Server Error');
  }
});

/**
 * @route GET /api/financial-variables
 * @desc Get financial variables data
 */
app.get('/api/financial-variables1', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM financial_variables1');
    res.json(result.rows);
  } catch (err: any) {
    console.error(err.message);
    res.status(500).send('Server Error');
  }
});

// Start server
app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
