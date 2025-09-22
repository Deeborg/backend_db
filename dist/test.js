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
var __rest = (this && this.__rest) || function (s, e) {
    var t = {};
    for (var p in s) if (Object.prototype.hasOwnProperty.call(s, p) && e.indexOf(p) < 0)
        t[p] = s[p];
    if (s != null && typeof Object.getOwnPropertySymbols === "function")
        for (var i = 0, p = Object.getOwnPropertySymbols(s); i < p.length; i++) {
            if (e.indexOf(p[i]) < 0 && Object.prototype.propertyIsEnumerable.call(s, p[i]))
                t[p[i]] = s[p[i]];
        }
    return t;
};
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.ensureTable = ensureTable;
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
    password: process.env.DB_PASSWORD || 'root',
    port: Number(process.env.DB_PORT) || 5432,
});
// --- TABLE NAME for journal update APIs ---
const TABLE_NAME = process.env.JOURNAL_TABLE || 'adjustment_entries';
/**
 * Ensures that a table exists with proper primary key
 */
function ensureTable(tableName_1, sampleRow_1) {
    return __awaiter(this, arguments, void 0, function* (tableName, sampleRow, overwrite = false, renameMap = {}) {
        const existingColumnsResult = yield pool.query(`SELECT column_name FROM information_schema.columns WHERE table_name = $1`, [tableName]);
        const existingColumns = existingColumnsResult.rows.map((r) => r.column_name);
        console.log(`Existing columns in ${tableName}:`, existingColumns); // Debug log
        let primaryKey;
        let excludeFromDynamicManagement = [];
        if (tableName === "financial_variables1" || tableName === "text_keys1") {
            primaryKey = "key";
        }
        else if (tableName === "trial_balance" || tableName === "adjustment_entries") {
            primaryKey = "glAccount";
            excludeFromDynamicManagement = [
                "glName",
                "accountType",
                "Level 1 Desc",
                "Level 2 Desc",
                "functionalArea",
            ];
        }
        else {
            throw new Error(`ensureTable: Unknown table name provided: ${tableName}`);
        }
        const duplicates = [];
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
            yield pool.query(createTableSQL);
        }
        else {
            for (const col of Object.keys(sampleRow)) {
                if (col === primaryKey || excludeFromDynamicManagement.includes(col))
                    continue;
                if (!existingColumns.includes(col)) {
                    console.log(`Adding new column ${col} to ${tableName}`); // Debug log
                    yield pool.query(`ALTER TABLE "${tableName}" ADD COLUMN "${col}" TEXT`);
                }
                else if (overwrite) {
                    console.log(`Dropping column ${col} from ${tableName}`); // Debug log
                    yield pool.query(`ALTER TABLE "${tableName}" DROP COLUMN IF EXISTS "${col}"`);
                    console.log(`Re-adding column ${col} to ${tableName}`); // Debug log
                    yield pool.query(`ALTER TABLE "${tableName}" ADD COLUMN "${col}" TEXT`);
                }
                else if (renameMap[col]) {
                    console.log(`Renaming column ${col} to ${renameMap[col]} in ${tableName}`); // Debug log
                    yield pool.query(`ALTER TABLE "${tableName}" ADD COLUMN "${renameMap[col]}" TEXT`);
                }
                else {
                    console.log(`Duplicate column ${col} found in ${tableName}`); // Debug log
                    duplicates.push(col);
                }
            }
        }
        return duplicates;
    });
}
/**
 * Ensures adj_entry_list table exists with status and approval columns
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
      "amount" NUMERIC NOT NULL,
      "status" TEXT DEFAULT 'pending',
      "entry_type" TEXT DEFAULT 'manual',
      "created_at" TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      "approved_at" TIMESTAMP NULL,
      "approved_by" TEXT NULL
    )
  `;
        yield pool.query(createTableSQL);
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
            yield pool.query(sql, values);
        }
    });
}
/**
 * Upsert for financial_variables1 and text_keys1
 */
function upsertRowsWithKey(tableName, rows) {
    return __awaiter(this, void 0, void 0, function* () {
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
            yield pool.query(sql, values);
        }
    });
}
/**
 * @route POST /api/data
 */
app.post("/api/data", (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    const { mappedData, overwrite, renameMap } = req.body;
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
        const newRow = { glAccount: row.glAccount, glName: row.glName };
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
            const existingColumnsResult = yield pool.query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'adjustment_entries'`);
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
                    yield pool.query(`ALTER TABLE "adjustment_entries" DROP COLUMN IF EXISTS "${col}"`);
                }
            }
        }
        const trialBalanceDuplicates = yield ensureTable("trial_balance", mappedData[0], overwrite !== null && overwrite !== void 0 ? overwrite : false, renameMap !== null && renameMap !== void 0 ? renameMap : {});
        const adjustmentEntriesDuplicates = yield ensureTable("adjustment_entries", transformedDataForAdjEntries[0], overwrite !== null && overwrite !== void 0 ? overwrite : false, renameMap !== null && renameMap !== void 0 ? renameMap : {});
        const allDuplicates = {};
        if (trialBalanceDuplicates.length > 0) {
            allDuplicates.trial_balance = trialBalanceDuplicates;
        }
        if (adjustmentEntriesDuplicates.length > 0) {
            allDuplicates.adjustment_entries = adjustmentEntriesDuplicates;
        }
        if (Object.keys(allDuplicates).length > 0 && !(overwrite !== null && overwrite !== void 0 ? overwrite : false)) {
            return res.status(409).json({
                msg: "Duplicate columns found and overwrite not requested.",
                duplicates: allDuplicates,
            });
        }
        yield upsertRows("trial_balance", mappedData);
        // Save adjustment entries to adj_entry_list for approval instead of directly to adjustment_entries
        const hashVal = crypto_1.default.randomBytes(8).toString('hex');
        const client = yield pool.connect();
        try {
            yield client.query('BEGIN');
            for (const row of transformedDataForAdjEntries) {
                const { glAccount, glName } = row;
                // Insert each period as a separate entry for approval
                for (const [period, amount] of Object.entries(row)) {
                    if (period !== 'glAccount' && period !== 'glName' && amount !== 0 && amount !== '0') {
                        yield client.query(`INSERT INTO adj_entry_list (hash_val, "glAccount", "glName", "period", "amount", "status", "entry_type") 
               VALUES ($1, $2, $3, $4, $5, $6, $7)`, [hashVal, glAccount, glName, period, parseFloat(amount) || 0, 'pending', 'excel_upload']);
                    }
                }
            }
            yield client.query('COMMIT');
            client.release();
            res.status(200).send("Trial balance data inserted successfully. Adjustment entries saved for admin approval.");
        }
        catch (err) {
            yield client.query('ROLLBACK');
            client.release();
            throw err;
        }
    }
    catch (error) {
        console.error("Error in /api/data:", error.message, error.stack);
        res.status(500).send(error.message || "Error inserting/updating data");
    }
}));
/**
 * Financial Variables APIs
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
app.post('/api/text-variables', (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    const { textVar1 } = req.body;
    if (!textVar1 || textVar1.length === 0) {
        return res.status(400).send('No data received');
    }
    try {
        yield ensureTable('text_keys1', textVar1[0]);
        yield upsertRowsWithKey('text_keys1', textVar1);
        res.status(200).send('textVar inserted/updated successfully');
    }
    catch (error) {
        console.error(error);
        res.status(500).send('Error inserting/updating data');
    }
}));
/**
 * Journal Metadata & Updates
 */
app.get('/api/journal/metadata', (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    try {
        const glAccountsResult = yield pool.query(`SELECT DISTINCT "glAccount", "glName" FROM ${TABLE_NAME} ORDER BY "glAccount"`);
        const glAccounts = glAccountsResult.rows;
        const columnsResult = yield pool.query(`SELECT column_name FROM information_schema.columns 
       WHERE table_name = $1 AND column_name NOT IN ('glAccount', 'glName')`, [TABLE_NAME]);
        const periods = columnsResult.rows.map((row) => row.column_name);
        res.json({ glAccounts, periods });
    }
    catch (err) {
        console.error('Error fetching metadata:', err);
        res.status(500).send('Error fetching journal metadata');
    }
}));
app.post('/api/journal/batch-update', (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    var _a;
    const entries = req.body;
    if (!Array.isArray(entries) || entries.length === 0) {
        return res
            .status(400)
            .json({ msg: 'Invalid request body. Expected an array of entries.' });
    }
    const client = yield pool.connect();
    const hashVal = crypto_1.default.randomBytes(8).toString('hex');
    try {
        yield client.query('BEGIN');
        for (const entry of entries) {
            const { glAccount, period, value } = entry;
            if (!glAccount || !period || value === undefined)
                continue;
            // Get GL Name from adjustment_entries table
            const glRes = yield client.query(`SELECT "glName" FROM ${TABLE_NAME} WHERE "glAccount" = $1`, [glAccount]);
            const glName = ((_a = glRes.rows[0]) === null || _a === void 0 ? void 0 : _a.glName) || '';
            // Save to adj_entry_list for approval (don't update adjustment_entries yet)
            yield client.query(`INSERT INTO adj_entry_list (hash_val, "glAccount", "glName", "period", "amount", "status", "entry_type") 
         VALUES ($1, $2, $3, $4, $5, $6, $7)`, [hashVal, glAccount, glName, period, value, 'pending', 'manual']);
        }
        yield client.query('COMMIT');
        res.json({ msg: 'Journal entries saved for admin approval', hashVal, status: 'pending' });
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
// Get all pending entries for admin approval
app.get('/api/journal/pending-entries', (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    try {
        const entriesResult = yield pool.query(`SELECT id, hash_val, "glAccount", "glName", "period", "amount", "entry_type", "created_at"
       FROM adj_entry_list 
       WHERE "status" = 'pending' 
       ORDER BY "created_at" DESC, hash_val`);
        res.json({ entries: entriesResult.rows });
    }
    catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error while fetching pending entries');
    }
}));
// Approve entries and move them to adjustment_entries
app.post('/api/journal/approve-entries', (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    const { entryIds, approvedBy = 'admin', reason = '' } = req.body;
    if (!Array.isArray(entryIds) || entryIds.length === 0) {
        return res.status(400).json({ msg: 'Invalid request body. Expected an array of entry IDs.' });
    }
    try {
        const placeholders = entryIds.map((_, i) => `$${i + 2}`).join(',');
        const result = yield pool.query(`UPDATE adj_entry_list 
       SET "status" = 'approved', "approved_at" = CURRENT_TIMESTAMP, "approved_by" = $1
       WHERE id IN (${placeholders}) `, [approvedBy, ...entryIds]);
        res.json({
            msg: 'Entries approved successfully',
            approvedCount: result.rowCount
        });
    }
    catch (err) {
        console.error('Approve failed:', err.message);
        res.status(500).send('Server Error during approval process');
    }
}));
// Reject entries
app.post('/api/journal/reject-entries', (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    const { entryIds, rejectedBy = 'admin', reason = '' } = req.body;
    if (!Array.isArray(entryIds) || entryIds.length === 0) {
        return res.status(400).json({ msg: 'Invalid request body. Expected an array of entry IDs.' });
    }
    try {
        const placeholders = entryIds.map((_, i) => `$${i + 2}`).join(',');
        const result = yield pool.query(`UPDATE adj_entry_list 
       SET "status" = 'rejected', "approved_at" = CURRENT_TIMESTAMP, "approved_by" = $1
       WHERE id IN (${placeholders}) AND "status" = 'pending'`, [rejectedBy, ...entryIds]);
        res.json({
            msg: 'Entries rejected successfully',
            rejectedCount: result.rowCount
        });
    }
    catch (err) {
        console.error('Rejection failed:', err.message);
        res.status(500).send('Server Error during rejection process');
    }
}));
// Get all pending entries for admin approval
app.get('/api/journal/pending-entries', (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    try {
        const entriesResult = yield pool.query(`SELECT id, hash_val, "glAccount", "glName", "period", "amount", "entry_type", "created_at"
       FROM adj_entry_list 
       WHERE "status" = 'pending' 
       ORDER BY "created_at" DESC, hash_val`);
        res.json({ entries: entriesResult.rows });
    }
    catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error while fetching pending entries');
    }
}));
app.get('/api/journal/entries', (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    try {
        const { period, status } = req.query;
        if (!period) {
            const periodsResult = yield pool.query(`SELECT DISTINCT "period" FROM adj_entry_list WHERE "status" = 'approved' ORDER BY "period"`);
            return res.json({ periods: periodsResult.rows.map((r) => r.period) });
        }
        let query = `SELECT id, hash_val, "glAccount", "glName", "period", "amount", "status", "entry_type", "created_at", "approved_at", "approved_by"
                 FROM adj_entry_list WHERE "period" = $1`;
        let params = [period];
        if (status) {
            query += ` AND "status" = $2`;
            params.push(status);
        }
        else {
            query += ` AND "status" = 'approved'`;
        }
        query += ` ORDER BY "created_at" DESC, hash_val`;
        const entriesResult = yield pool.query(query, params);
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
 * Update APIs
 */
app.post('/api/update-financial-vars', (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    try {
        const dataArray = Array.isArray(req.body) ? req.body : [req.body];
        for (const row of dataArray) {
            const { key } = row, columnsToUpdate = __rest(row, ["key"]);
            if (!key || Object.keys(columnsToUpdate).length === 0)
                continue;
            const setClauses = Object.keys(columnsToUpdate)
                .map((col, i) => `"${col}" = $${i + 2}`)
                .join(', ');
            const values = [key, ...Object.values(columnsToUpdate)];
            const query = `UPDATE financial_variables1 SET ${setClauses} WHERE key = $1`;
            yield pool.query(query, values);
        }
        res.status(200).json({ message: 'Update successful' });
    }
    catch (error) {
        console.error('Error updating:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
}));
app.post('/api/update-text-vars', (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    try {
        const dataArray = Array.isArray(req.body) ? req.body : [req.body];
        for (const row of dataArray) {
            const { key } = row, columnsToUpdate = __rest(row, ["key"]);
            if (!key || Object.keys(columnsToUpdate).length === 0)
                continue;
            const setClauses = Object.keys(columnsToUpdate)
                .map((col, i) => `"${col}" = $${i + 2}`)
                .join(', ');
            const values = [key, ...Object.values(columnsToUpdate)];
            const query = `UPDATE text_keys1 SET ${setClauses} WHERE key = $1`;
            yield pool.query(query, values);
        }
        res.status(200).json({ message: 'Update successful' });
    }
    catch (error) {
        console.error('Error updating:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
}));
/**
 * Fetch APIs
 */
app.get('/api/text_keys1', (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    try {
        const updatedtext_keys = yield pool.query('SELECT * FROM text_keys1');
        res.json(updatedtext_keys.rows);
    }
    catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
}));
/**
 * Trial Balance APIs
 */
app.get('/api/trial-balance/periods', (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    try {
        const columnsResult = yield pool.query(`SELECT column_name FROM information_schema.columns 
       WHERE table_name = 'trial_balance' 
       AND column_name NOT IN ('glAccount', 'glName', 'accountType', 'Level 1 Desc', 'Level 2 Desc', 'functionalArea')
       ORDER BY column_name`);
        const periods = columnsResult.rows.map((row) => row.column_name);
        res.json({ periods });
    }
    catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
}));
app.get('/api/trial-balance/data', (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    try {
        const { period1, period2 } = req.query;
        if (!period1 || !period2) {
            return res.status(400).json({ error: 'Both period1 and period2 are required' });
        }
        const query = `
      SELECT "glAccount", "glName", "accountType", "Level 1 Desc", "Level 2 Desc", "functionalArea",
             "${period1}" as "amountCurrent", "${period2}" as "amountPrevious"
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
 * Financial Variables (v1)
 */
app.get('/api/financial-variables1', (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    try {
        const result = yield pool.query('SELECT * FROM financial_variables1');
        res.json(result.rows);
    }
    catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
}));
// --- Start Server ---
app.listen(PORT, () => console.log(`✅ Server running on http://localhost:${PORT}`));
