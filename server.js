"use strict";
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const cors_1 = __importDefault(require("cors"));
const body_parser_1 = __importDefault(require("body-parser"));
const pg_1 = require("pg");
const dotenv_1 = __importDefault(require("dotenv"));
const crypto_1 = __importDefault(require("crypto"));
dotenv_1.default.config();
const app = (0, express_1.default)();
const PORT = process.env.API_PORT || 5000;
app.use((0, cors_1.default)());
app.use(body_parser_1.default.json({ limit: '100mb' }));
app.use(express_1.default.json({ limit: '100mb' }));
app.use(express_1.default.urlencoded({ limit: '100mb', extended: true }));
// --- PostgreSQL Connection Pool ---
const pool = new pg_1.Pool({
    user: process.env.DB_USER || 'postgres',
    host: process.env.DB_HOST || 'localhost',
    database: process.env.DB_DATABASE || 'Y_Finance',
    password: process.env.DB_PASSWORD || 'password1A',
    port: Number(process.env.DB_PORT) || 5432,
});
// --- TABLE NAME for journal update APIs ---
const TABLE_NAME = process.env.JOURNAL_TABLE || 'adjustment_entries';
/**
 * Ensures that a table exists with proper primary key
 */
function ensureTable(tableName, sampleRow) {
    return __awaiter(this, void 0, void 0, function* () {
        const existingColumnsResult = yield pool.query(`SELECT column_name FROM information_schema.columns WHERE table_name = $1`, [tableName]);
        const existingColumns = existingColumnsResult.rows.map(r => r.column_name);
        const primaryKey = tableName === 'financial_variables1' ? 'key' : 'glAccount';
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
            yield pool.query(createTableSQL);
        }
        else {
            for (const col of Object.keys(sampleRow)) {
                if (!existingColumns.includes(col)) {
                    yield pool.query(`ALTER TABLE "${tableName}" ADD COLUMN "${col}" TEXT`);
                }
            }
        }
    });
}
/**
 * Ensures adj_entry_list table exists
 */
function ensureAdjEntryTable() {
    return __awaiter(this, void 0, void 0, function* () {
        const createTableSQL = `
    CREATE TABLE IF NOT EXISTS adj_entry_list (
      id SERIAL PRIMARY KEY,
      hash_val TEXT NOT NULL,
      "glAccount" TEXT NOT NULL,
      "glName" TEXT NOT NULL,
      "period" TEXT NOT NULL,
      "amount" NUMERIC NOT NULL
    );
  `;
        yield pool.query(createTableSQL);
    });
}
ensureAdjEntryTable().catch(console.error);
/**
 * Upsert for glAccount based tables
 */
function upsertRows(tableName, rows) {
    return __awaiter(this, void 0, void 0, function* () {
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
            yield pool.query(sql, values);
        }
    });
}
/**
 * Upsert for financial_variables1
 */
function upsertRowsWithKey(tableName, rows) {
    return __awaiter(this, void 0, void 0, function* () {
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
            yield pool.query(sql, values);
        }
    });
}
/**
 * @route POST /api/data
 * @desc  Insert mappedData and transformedData into PostgreSQL with upsert
 */
app.post('/api/data', (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    const { mappedData } = req.body;
    if (!mappedData || mappedData.length === 0) {
        return res.status(400).send('No data received');
    }
    const exclude = ['createdby', 'accountType', 'Level 1 Desc', 'Level 2 Desc', 'functionalArea'];
    const transformedData = mappedData.map((row) => {
        const newRow = {};
        Object.keys(row).forEach((key) => {
            if (!exclude.includes(key)) {
                if (key === 'glAccount' || key === 'glName') {
                    newRow[key] = row[key];
                }
                else {
                    newRow[key] = 0;
                }
            }
        });
        return newRow;
    });
    try {
        yield ensureTable('trial_balance', mappedData[0]);
        yield ensureTable('adjustment_entries', transformedData[0]);
        yield upsertRows('trial_balance', mappedData);
        yield upsertRows('adjustment_entries', transformedData);
        res.status(200).send('Both mappedData and transformedData inserted/updated successfully');
    }
    catch (error) {
        console.error(error);
        res.status(500).send('Error inserting/updating data');
    }
}));
/**
 * @route POST /api/financialvar-updated
 */
app.post('/api/financialvar-updated', (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    const { financialVar1 } = req.body;
    if (!financialVar1 || financialVar1.length === 0) {
        return res.status(400).send('No data received');
    }
    try {
        yield ensureTable('financial_variables1', financialVar1[0]);
        yield upsertRowsWithKey('financial_variables1', financialVar1);
        res.status(200).send('financialVar inserted/updated successfully');
    }
    catch (error) {
        console.error(error);
        res.status(500).send('Error inserting/updating data');
    }
}));
/**
 * @route GET /api/journal/metadata
 * @desc  Get GL accounts and period column headers
 */
app.get('/api/journal/metadata', (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    try {
        const glAccountsResult = yield pool.query(`SELECT DISTINCT "glAccount", "glName" FROM ${TABLE_NAME} ORDER BY "glAccount"`);
        const glAccounts = glAccountsResult.rows;
        const columnsResult = yield pool.query(`
      SELECT column_name 
      FROM information_schema.columns 
      WHERE table_name = $1 AND column_name NOT IN ('glAccount', 'glName')
      `, [TABLE_NAME]);
        const periods = columnsResult.rows.map(row => row.column_name);
        res.json({ glAccounts, periods });
    }
    catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
}));
/**
 * @route POST /api/journal/batch-update
 * @desc Updates multiple journal entries in a single transaction
 */
app.post('/api/journal/batch-update', (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    var _a;
    const entries = req.body;
    if (!Array.isArray(entries) || entries.length === 0) {
        return res.status(400).json({ msg: 'Invalid request body. Expected an array of entries.' });
    }
    const client = yield pool.connect();
    const hashVal = crypto_1.default.randomBytes(8).toString('hex');
    try {
        yield client.query('BEGIN');
        for (const entry of entries) {
            const { glAccount, period, value } = entry;
            if (!glAccount || !period || value === undefined)
                continue;
            const updateQuery = `
        UPDATE ${TABLE_NAME} 
        SET "${period}" = $1 
        WHERE "glAccount" = $2
      `;
            yield client.query(updateQuery, [value, glAccount]);
            const glRes = yield client.query(`SELECT "glName" FROM ${TABLE_NAME} WHERE "glAccount" = $1`, [glAccount]);
            const glName = ((_a = glRes.rows[0]) === null || _a === void 0 ? void 0 : _a.glName) || '';
            yield client.query(`INSERT INTO adj_entry_list (hash_val, "glAccount", "glName", "period", "amount")
         VALUES ($1, $2, $3, $4, $5)`, [hashVal, glAccount, glName, period, value]);
        }
        yield client.query('COMMIT');
        res.json({ msg: 'Journal entries posted successfully', hashVal });
    }
    catch (err) {
        yield client.query('ROLLBACK');
        console.error('Transaction failed:', err.message);
        res.status(500).send('Server Error during transaction');
    }
    finally {
        client.release();
    }
}));
/**
 * @route GET /api/journal/entries
 */
app.get('/api/journal/entries', (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    try {
        const { period } = req.query;
        if (!period) {
            const periodsResult = yield pool.query(`SELECT DISTINCT "period" FROM adj_entry_list ORDER BY "period"`);
            return res.json({ periods: periodsResult.rows.map(r => r.period) });
        }
        const entriesResult = yield pool.query(`SELECT hash_val, "glAccount", "glName", "period", "amount"
       FROM adj_entry_list 
       WHERE "period" = $1 
       ORDER BY hash_val`, [period]);
        res.json({ entries: entriesResult.rows });
    }
    catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error while fetching entries');
    }
}));
app.get('/api/journal/updated', (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    try {
        const glAccountsupdated = yield pool.query('SELECT * FROM adjustment_entries');
        res.json(glAccountsupdated.rows);
    }
    catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
}));
/**
 * @route GET /api/trial-balance/periods
 * @desc Get available periods from trial_balance table
 */
app.get('/api/trial-balance/periods', (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    try {
        const columnsResult = yield pool.query(`
      SELECT column_name 
      FROM information_schema.columns 
      WHERE table_name = 'trial_balance' 
      AND column_name NOT IN ('glAccount', 'glName', 'accountType', 'Level 1 Desc', 'Level 2 Desc', 'functionalArea')
      ORDER BY column_name
    `);
        const periods = columnsResult.rows.map(row => row.column_name);
        res.json({ periods });
    }
    catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
}));
/**
 * @route GET /api/trial-balance/data
 * @desc Get trial balance data for selected periods
 */
app.get('/api/trial-balance/data', (req, res) => __awaiter(void 0, void 0, void 0, function* () {
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
        const result = yield pool.query(query);
        res.json(result.rows);
    }
    catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
}));
/**
 * @route GET /api/financial-variables
 * @desc Get financial variables data
 */
app.get('/api/financial-variables', (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    try {
        // Check if the table exists first
        const tableExists = yield pool.query(`
      SELECT EXISTS (
        SELECT FROM information_schema.tables 
        WHERE table_name = 'financial_variables1'
      );
    `);
        if (tableExists.rows[0].exists) {
            const result = yield pool.query('SELECT * FROM financial_variables1');
            res.json(result.rows);
        }
        else {
            // Return empty array if table doesn't exist
            console.log('financial_variables1 table does not exist, returning empty array');
            res.json([]);
        }
    }
    catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
}));
// Start server
app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
