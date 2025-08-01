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
 * @route POST /api/data
 * @desc  Insert mappedData and transformedData into PostgreSQL
 */
app.post('/api/data', (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    const { mappedData } = req.body;
    if (!mappedData || mappedData.length === 0) {
        return res.status(400).send('No data received');
    }
    const exclude = ['createdby', 'accountType', 'Level 1 Desc', 'Level 2 Desc', 'functionalArea'];
    // Transform data
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
        yield pool.query(createOriginalTableSQL);
        for (const row of mappedData) {
            const rowColumns = Object.keys(row);
            const values = Object.values(row);
            const colNames = rowColumns.map(col => `"${col}"`).join(', ');
            const paramPlaceholders = rowColumns.map((_, i) => `$${i + 1}`).join(', ');
            const sql = `INSERT INTO trial_balance (${colNames}) VALUES (${paramPlaceholders})`;
            yield pool.query(sql, values);
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
        yield pool.query(createTransformedTableSQL);
        for (const row of transformedData) {
            const rowColumns = Object.keys(row);
            const values = Object.values(row);
            const colNames = rowColumns.map(col => `"${col}"`).join(', ');
            const paramPlaceholders = rowColumns.map((_, i) => `$${i + 1}`).join(', ');
            const sql = `INSERT INTO adjustment_entries (${colNames}) VALUES (${paramPlaceholders})`;
            yield pool.query(sql, values);
        }
        res.status(200).send('Both mappedData and transformedData inserted successfully');
    }
    catch (error) {
        console.error(error);
        res.status(500).send('Error inserting data');
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
// /**
//  * @route POST /api/journal/update
//  * @desc  Update a specific cell in the journal table
//  */
// app.post('/api/journal/update', async (req, res) => {
//   const { glAccount, period, value } = req.body;
//   if (!glAccount || !period || value === undefined) {
//     return res.status(400).json({ msg: 'Please provide glAccount, period, and value' });
//   }
//   try {
//     const updateQuery = `
//       UPDATE ${TABLE_NAME} 
//       SET "${period}" = $1 
//       WHERE "glAccount" = $2
//     `;
//     await pool.query(updateQuery, [value, glAccount]);
//     res.json({ msg: 'Journal entry updated successfully' });
//   } catch (err: any) {
//     console.error(err.message);
//     res.status(500).send('Server Error');
//   }
// });
/**
 * @route   POST /api/journal/batch-update
 * @desc    Updates multiple journal entries in a single transaction
 */
app.post('/api/journal/batch-update', (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    const entries = req.body; // Expects an array: [{ glAccount, period, value }, ...]
    if (!Array.isArray(entries) || entries.length === 0) {
        return res.status(400).json({ msg: 'Invalid request body. Expected an array of entries.' });
    }
    const client = yield pool.connect(); // Get a client from the pool for transaction
    try {
        yield client.query('BEGIN'); // Start transaction
        // Use Promise.all to run all update queries concurrently
        const updatePromises = entries.map(entry => {
            const { glAccount, period, value } = entry;
            const updateQuery = `
        UPDATE ${TABLE_NAME} 
        SET "${period}" = $1 
        WHERE "glAccount" = $2
      `;
            // Ensure values are valid before querying
            if (glAccount && period && value !== undefined) {
                return client.query(updateQuery, [value, glAccount]);
            }
            return Promise.resolve(); // Ignore invalid entries
        });
        yield Promise.all(updatePromises);
        yield client.query('COMMIT'); // Commit transaction if all updates succeed
        res.json({ msg: 'Journal entries posted successfully' });
    }
    catch (err) {
        yield client.query('ROLLBACK'); // Rollback transaction on any error
        console.error('Transaction failed:', err.message);
        res.status(500).send('Server Error during transaction');
    }
    finally {
        client.release(); // IMPORTANT: Release the client back to the pool
    }
}));
// Start server
app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
