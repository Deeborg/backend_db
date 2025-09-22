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

// --- TABLE NAME for journal update APIs ---
const TABLE_NAME = process.env.JOURNAL_TABLE || 'adjustment_entries';

/**
 * Ensures that a table exists with proper primary key
 */
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
        console.log(`Dropping column ${col} from ${tableName}`); // Debug log
        await pool.query(`ALTER TABLE "${tableName}" DROP COLUMN IF EXISTS "${col}"`);
        console.log(`Re-adding column ${col} to ${tableName}`); // Debug log
        await pool.query(`ALTER TABLE "${tableName}" ADD COLUMN "${col}" TEXT`);
      } else if (renameMap[col]) {
        console.log(`Renaming column ${col} to ${renameMap[col]} in ${tableName}`); // Debug log
        await pool.query(`ALTER TABLE "${tableName}" ADD COLUMN "${renameMap[col]}" TEXT`);
      } else {
        console.log(`Duplicate column ${col} found in ${tableName}`); // Debug log
        duplicates.push(col);
      }
    }
  }
  return duplicates;
}

/**
 * Ensures adj_entry_list table exists with status and approval columns
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
      "status" TEXT DEFAULT 'pending',
      "entry_type" TEXT DEFAULT 'manual',
      "created_at" TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      "approved_at" TIMESTAMP NULL,
      "approved_by" TEXT NULL
    )
  `;
  await pool.query(createTableSQL);
  
  // // Add new columns if they don't exist (for existing tables)
  // const alterQueries = [
  //   `ALTER TABLE adj_entry_list ADD COLUMN IF NOT EXISTS "status" TEXT DEFAULT 'pending'`,
  //   `ALTER TABLE adj_entry_list ADD COLUMN IF NOT EXISTS "entry_type" TEXT DEFAULT 'manual'`,
  //   `ALTER TABLE adj_entry_list ADD COLUMN IF NOT EXISTS "created_at" TIMESTAMP DEFAULT CURRENT_TIMESTAMP`,
  //   `ALTER TABLE adj_entry_list ADD COLUMN IF NOT EXISTS "approved_at" TIMESTAMP NULL`,
  //   `ALTER TABLE adj_entry_list ADD COLUMN IF NOT EXISTS "approved_by" TEXT NULL`
  // ];
  
  // for (const query of alterQueries) {
  //   try {
  //     await pool.query(query);
  //   } catch (error) {
  //     console.log('Column may already exist:', error);
  //   }
  // }
}
ensureAdjEntryTable().catch(console.error);

/**
 * Upsert for glAccount based tables
 */
async function upsertRows(tableName: string, rows: Record<string, any>[]) {
  for (const row of rows) {
    const columns = Object.keys(row);
    const values = Object.values(row);
    const colNames = columns.map((col) => `"${col}"`).join(', ');
    const paramPlaceholders = columns.map((_, i) => `$${i + 1}`).join(', ');

    const updateAssignments = columns
      .filter((col) => col !== 'glAccount')
      .map((col) => `"${col}" = EXCLUDED."${col}"`)
      .join(', ');

    const sql = `
      INSERT INTO ${tableName} (${colNames})
      VALUES (${paramPlaceholders})
      ON CONFLICT ("glAccount") DO UPDATE SET ${updateAssignments}
    `;
    await pool.query(sql, values);
  }
}

/**
 * Upsert for financial_variables1 and text_keys1
 */
async function upsertRowsWithKey(tableName: string, rows: Record<string, any>[]) {
  for (const row of rows) {
    const columns = Object.keys(row);
    const values = Object.values(row);
    const colNames = columns.map((col) => `"${col}"`).join(', ');
    const paramPlaceholders = columns.map((_, i) => `$${i + 1}`).join(', ');

    const updateAssignments = columns
      .filter((col) => col !== 'key')
      .map((col) => `"${col}" = COALESCE(${tableName}."${col}", EXCLUDED."${col}")`)
      .join(', ');

    const sql = `
      INSERT INTO ${tableName} (${colNames})
      VALUES (${paramPlaceholders})
      ON CONFLICT ("key") DO UPDATE SET ${updateAssignments}
    `;
    await pool.query(sql, values);
  }
}

/**
 * @route POST /api/data
 */
app.post("/api/data", async (req: Request, res: Response) => {
  const { mappedData, overwrite, renameMap } = req.body as {
    mappedData: Record<string, any>[];
    overwrite?: boolean;
    renameMap?: Record<string, string>;
  };

  console.log("Received overwrite flag:", overwrite); // Debug log

  if (!mappedData || mappedData.length === 0) {
    return res.status(400).send("No data received");
  }

  const excludeFromDynamicAdjEntryProcessing = [
    "accountType",
    "Level 1 Desc",
    "Level 2 Desc",
    "functionalArea",
  ];

  // Transform mappedData to fit adjustment_entries structure
  const transformedDataForAdjEntries = mappedData.map((row) => {
    const newRow: Record<string, any> = { glAccount: row.glAccount, glName: row.glName };
    Object.keys(row).forEach((key) => {
      if (!excludeFromDynamicAdjEntryProcessing.includes(key) && key !== "glAccount" && key !== "glName") {
        newRow[key] = row[key] || 0; // Preserve existing values or set to 0
      }
    });
    return newRow;
  });

  console.log("Transformed data for adjustment_entries:", transformedDataForAdjEntries[0]); // Debug log

  try {
    // Explicitly drop dynamic columns if overwrite is true
    if (overwrite) {
      const existingColumnsResult = await pool.query(
        `SELECT column_name FROM information_schema.columns WHERE table_name = 'adjustment_entries'`
      );
      const existingColumns = existingColumnsResult.rows.map((r) => r.column_name);
      const excludeFromDynamicManagement = [
        "glAccount",
        "glName",
        "accountType",
        "Level 1 Desc",
        "Level 2 Desc",
        "functionalArea",
      ];

      for (const col of existingColumns) {
        if (!excludeFromDynamicManagement.includes(col)) {
          console.log(`Dropping column ${col} from adjustment_entries`);
          await pool.query(`ALTER TABLE "adjustment_entries" DROP COLUMN IF EXISTS "${col}"`);
        }
      }
    }

    const trialBalanceDuplicates = await ensureTable(
      "trial_balance",
      mappedData[0],
      overwrite ?? false,
      renameMap ?? {}
    );

    const adjustmentEntriesDuplicates = await ensureTable(
      "adjustment_entries",
      transformedDataForAdjEntries[0],
      overwrite ?? false,
      renameMap ?? {}
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

    await upsertRows("trial_balance", mappedData);
    
    // Save adjustment entries to adj_entry_list for approval instead of directly to adjustment_entries
    const hashVal = crypto.randomBytes(8).toString('hex');
    const client = await pool.connect();
    
    try {
      await client.query('BEGIN');
      
      for (const row of transformedDataForAdjEntries) {
        const { glAccount, glName } = row;
        
        // Insert each period as a separate entry for approval
        for (const [period, amount] of Object.entries(row)) {
          if (period !== 'glAccount' && period !== 'glName' && amount !== 0 && amount !== '0') {
            await client.query(
              `INSERT INTO adj_entry_list (hash_val, "glAccount", "glName", "period", "amount", "status", "entry_type") 
               VALUES ($1, $2, $3, $4, $5, $6, $7)`,
              [hashVal, glAccount, glName, period, parseFloat(amount as string) || 0, 'pending', 'excel_upload']
            );
          }
        }
      }
      
      await client.query('COMMIT');
      client.release();
      
      res.status(200).send("Trial balance data inserted successfully. Adjustment entries saved for admin approval.");
    } catch (err: any) {
      await client.query('ROLLBACK');
      client.release();
      throw err;
    }
  } catch (error: any) {
    console.error("Error in /api/data:", error.message, error.stack);
    res.status(500).send(error.message || "Error inserting/updating data");
  }
});

/**
 * Financial Variables APIs
 */
app.post('/api/financialvar-updated', async (req, res) => {
  const { financialVar1 } = req.body as { financialVar1: Record<string, any>[] };
  if (!financialVar1 || financialVar1.length === 0) {
    return res.status(400).send('No data received');
  }
  try {
    await ensureTable('financial_variables1', financialVar1[0]);
    await upsertRowsWithKey('financial_variables1', financialVar1);
    res.status(200).send('financialVar inserted/updated successfully');
  } catch (error) {
    console.error(error);
    res.status(500).send('Error inserting/updating data');
  }
});

app.post('/api/text-variables', async (req, res) => {
  const { textVar1 } = req.body as { textVar1: Record<string, any>[] };
  if (!textVar1 || textVar1.length === 0) {
    return res.status(400).send('No data received');
  }
  try {
    await ensureTable('text_keys1', textVar1[0]);
    await upsertRowsWithKey('text_keys1', textVar1);
    res.status(200).send('textVar inserted/updated successfully');
  } catch (error) {
    console.error(error);
    res.status(500).send('Error inserting/updating data');
  }
});

/**
 * Journal Metadata & Updates
 */
app.get('/api/journal/metadata', async (req, res) => {
  try {
    const glAccountsResult = await pool.query(
      `SELECT DISTINCT "glAccount", "glName" FROM ${TABLE_NAME} ORDER BY "glAccount"`
    );
    const glAccounts = glAccountsResult.rows;

    const columnsResult = await pool.query(
      `SELECT column_name FROM information_schema.columns 
       WHERE table_name = $1 AND column_name NOT IN ('glAccount', 'glName')`,
      [TABLE_NAME]
    );
    const periods = columnsResult.rows.map((row) => row.column_name);

    res.json({ glAccounts, periods });
  } catch (err) {
    console.error('Error fetching metadata:', err);
    res.status(500).send('Error fetching journal metadata');
  }
});

app.post('/api/journal/batch-update', async (req, res) => {
  const entries = req.body;
  if (!Array.isArray(entries) || entries.length === 0) {
    return res
      .status(400)
      .json({ msg: 'Invalid request body. Expected an array of entries.' });
  }

  const client = await pool.connect();
  const hashVal = crypto.randomBytes(8).toString('hex');

  try {
    await client.query('BEGIN');
    for (const entry of entries) {
      const { glAccount, period, value } = entry;
      if (!glAccount || !period || value === undefined) continue;

      // Get GL Name from adjustment_entries table
      const glRes = await client.query(
        `SELECT "glName" FROM ${TABLE_NAME} WHERE "glAccount" = $1`,
        [glAccount]
      );
      const glName = glRes.rows[0]?.glName || '';

      // Save to adj_entry_list for approval (don't update adjustment_entries yet)
      await client.query(
        `INSERT INTO adj_entry_list (hash_val, "glAccount", "glName", "period", "amount", "status", "entry_type") 
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [hashVal, glAccount, glName, period, value, 'pending', 'manual']
      );
    }
    await client.query('COMMIT');
    res.json({ msg: 'Journal entries saved for admin approval', hashVal, status: 'pending' });
  } catch (err: any) {
    await client.query('ROLLBACK');
    console.error('Transaction failed:', err.message);
    res.status(500).send('Server Error during transaction');
  } finally {
    client.release();
  }
});

// Get all pending entries for admin approval
app.get('/api/journal/pending-entries', async (req, res) => {
  try {
    const entriesResult = await pool.query(
      `SELECT id, hash_val, "glAccount", "glName", "period", "amount", "entry_type", "created_at"
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

// Approve entries and move them to adjustment_entries
app.post('/api/journal/approve-entries', async (req: Request, res: Response) => {
 const { entryIds, approvedBy = 'admin', reason = '' } = req.body;
  
  if (!Array.isArray(entryIds) || entryIds.length === 0) {
    return res.status(400).json({ msg: 'Invalid request body. Expected an array of entry IDs.' });
  }

  try {
    const placeholders = entryIds.map((_, i) => `$${i + 2}`).join(',');
    const result = await pool.query(
      `UPDATE adj_entry_list 
       SET "status" = 'approved', "approved_at" = CURRENT_TIMESTAMP, "approved_by" = $1
       WHERE id IN (${placeholders}) `,
      [approvedBy, ...entryIds]
    );

    res.json({ 
      msg: 'Entries approved successfully', 
      approvedCount: result.rowCount 
    });
  } catch (err: any) {
    console.error('Approve failed:', err.message);
    res.status(500).send('Server Error during approval process');
  }
  
});

// Reject entries
app.post('/api/journal/reject-entries', async (req, res) => {
  const { entryIds, rejectedBy = 'admin', reason = '' } = req.body;
  
  if (!Array.isArray(entryIds) || entryIds.length === 0) {
    return res.status(400).json({ msg: 'Invalid request body. Expected an array of entry IDs.' });
  }

  try {
    const placeholders = entryIds.map((_, i) => `$${i + 2}`).join(',');
    const result = await pool.query(
      `UPDATE adj_entry_list 
       SET "status" = 'rejected', "approved_at" = CURRENT_TIMESTAMP, "approved_by" = $1
       WHERE id IN (${placeholders}) AND "status" = 'pending'`,
      [rejectedBy, ...entryIds]
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

// Get all pending entries for admin approval
app.get('/api/journal/pending-entries', async (req, res) => {
  try {
    const entriesResult = await pool.query(
      `SELECT id, hash_val, "glAccount", "glName", "period", "amount", "entry_type", "created_at"
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

app.get('/api/journal/entries', async (req, res) => {
  try {
    const { period, status } = req.query;
    if (!period) {
      const periodsResult = await pool.query(
        `SELECT DISTINCT "period" FROM adj_entry_list WHERE "status" = 'approved' ORDER BY "period"`
      );
      return res.json({ periods: periodsResult.rows.map((r) => r.period) });
    }
    
    let query = `SELECT id, hash_val, "glAccount", "glName", "period", "amount", "status", "entry_type", "created_at", "approved_at", "approved_by"
                 FROM adj_entry_list WHERE "period" = $1`;
    let params = [period];
    
    if (status) {
      query += ` AND "status" = $2`;
      params.push(status as string);
    } else {
      query += ` AND "status" = 'approved'`;
    }
    
    query += ` ORDER BY "created_at" DESC, hash_val`;
    
    const entriesResult = await pool.query(query, params);
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

/**
 * Update APIs
 */
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
      const query = `UPDATE financial_variables1 SET ${setClauses} WHERE key = $1`;
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
      const query = `UPDATE text_keys1 SET ${setClauses} WHERE key = $1`;
      await pool.query(query, values);
    }
    res.status(200).json({ message: 'Update successful' });
  } catch (error) {
    console.error('Error updating:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * Fetch APIs
 */




app.get('/api/text_keys1', async (req, res) => {
  try {
    const updatedtext_keys = await pool.query('SELECT * FROM text_keys1');
    res.json(updatedtext_keys.rows);
  } catch (err: any) {
    console.error(err.message);
    res.status(500).send('Server Error');
  }
});

/**
 * Trial Balance APIs
 */
app.get('/api/trial-balance/periods', async (req, res) => {
  try {
    const columnsResult = await pool.query(
      `SELECT column_name FROM information_schema.columns 
       WHERE table_name = 'trial_balance' 
       AND column_name NOT IN ('glAccount', 'glName', 'accountType', 'Level 1 Desc', 'Level 2 Desc', 'functionalArea')
       ORDER BY column_name`
    );
    const periods = columnsResult.rows.map((row) => row.column_name);
    res.json({ periods });
  } catch (err: any) {
    console.error(err.message);
    res.status(500).send('Server Error');
  }
});

app.get('/api/trial-balance/data', async (req, res) => {
  try {
    const { period1, period2 } = req.query as { period1?: string; period2?: string };
    if (!period1 || !period2) {
      return res.status(400).json({ error: 'Both period1 and period2 are required' });
    }
    const query = `
      SELECT "glAccount", "glName", "accountType", "Level 1 Desc", "Level 2 Desc", "functionalArea",
             "${period1}" as "amountCurrent", "${period2}" as "amountPrevious"
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
 * Financial Variables (v1)
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

// --- Start Server ---
app.listen(PORT, () =>
  console.log(`✅ Server running on http://localhost:${PORT}`)
);
