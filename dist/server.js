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
 * Ensures that a table exists with "glAccount" as primary key
 */
function ensureTable(tableName, sampleRow) {
    return __awaiter(this, void 0, void 0, function* () {
        const existingColumnsResult = yield pool.query(`SELECT column_name FROM information_schema.columns WHERE table_name = $1`, [tableName]);
        const existingColumns = existingColumnsResult.rows.map(r => r.column_name);
        // Create table if it doesn't exist
        if (existingColumns.length === 0) {
            const columnDefs = Object.keys(sampleRow)
                .filter(col => col !== 'glAccount')
                .map(col => `"${col}" TEXT`);
            const createTableSQL = `
      CREATE TABLE IF NOT EXISTS ${tableName} (
        "glAccount" TEXT PRIMARY KEY,
        ${columnDefs.join(',\n        ')}
      );
    `;
            yield pool.query(createTableSQL);
        }
        else {
            // Add any missing columns dynamically
            for (const col of Object.keys(sampleRow)) {
                if (!existingColumns.includes(col)) {
                    yield pool.query(`ALTER TABLE ${tableName} ADD COLUMN "${col}" TEXT`);
                }
            }
        }
    });
}
/**
 * Inserts or updates rows using ON CONFLICT (upsert)
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
 * @route POST /api/data
 * @desc  Insert mappedData and transformedData into PostgreSQL with upsert
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
        // Ensure tables exist and have correct structure
        yield ensureTable('trial_balance', mappedData[0]);
        yield ensureTable('adjustment_entries', transformedData[0]);
        // Insert or update data
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
    const entries = req.body; // Expects an array: [{ glAccount, period, value }, ...]
    if (!Array.isArray(entries) || entries.length === 0) {
        return res.status(400).json({ msg: 'Invalid request body. Expected an array of entries.' });
    }
    const client = yield pool.connect();
    try {
        yield client.query('BEGIN');
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
        yield Promise.all(updatePromises);
        yield client.query('COMMIT');
        res.json({ msg: 'Journal entries posted successfully' });
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
// Start server
app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
