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
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const envPath = path_1.default.resolve(__dirname, '.env');
if (fs_1.default.existsSync(envPath)) {
    const envFileContent = fs_1.default.readFileSync(envPath, 'utf8');
    envFileContent.split('\n').forEach(line => {
        // This regex handles quotes and comments
        const match = line.match(/^\s*([\w.-]+)\s*=\s*(.*)?\s*$/);
        if (match) {
            const key = match[1];
            let value = match[2] || '';
            // Remove quotes from the value
            value = value.replace(/^['"](.*)['"]$/, '$1').trim();
            process.env[key] = value;
        }
    });
    console.log('✅ Manually loaded .env file successfully.');
}
else {
    console.error('❌ CRITICAL: .env file not found at path:', envPath);
}
const express_1 = __importDefault(require("express"));
const cors_1 = __importDefault(require("cors"));
const body_parser_1 = __importDefault(require("body-parser"));
const pg_1 = require("pg");
const crypto_1 = __importDefault(require("crypto"));
const bcryptjs_1 = __importDefault(require("bcryptjs"));
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
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
function ensureRequiredTables() {
    return __awaiter(this, void 0, void 0, function* () {
        const adjEntryTableSQL = `
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
      "created_by" TEXT NULL,
      "created_at" TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      "approved_at" TIMESTAMP NULL,
      "approved_by" TEXT NULL,
      "rejected_by"TEXT NULL,
      "rejected_at"  TIMESTAMP NULL,
      "admin_comments" TEXT NULL
    );
  `;
        yield pool.query(adjEntryTableSQL);
        console.log("Checked/Created adj_entry_list table.");
        // NEW: Create the users table for authentication
        const usersTableSQL = `
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      username TEXT UNIQUE NOT NULL, -- This will store the email
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL , -- Can be 'user' or 'admin'
      name TEXT,
      mobile TEXT,   
      company TEXT,
      created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
    );
  `;
        yield pool.query(usersTableSQL);
        console.log("Checked/Created users table.");
        const noteStatusTableSQL = `
    CREATE TABLE IF NOT EXISTS note_edit_status (
      id SERIAL PRIMARY KEY,
      note_number TEXT NOT NULL,
      period_key TEXT NOT NULL,
      is_edited BOOLEAN DEFAULT FALSE,
      last_edited_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(note_number, period_key)
    );
  `;
        yield pool.query(noteStatusTableSQL);
        console.log("Checked/Created note_edit_status table.");
    });
}
// Run the setup function on application start
ensureRequiredTables().catch(console.error);
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
                    if (tableName === 'trial_balance') {
                        console.log(`Delete rows ${col} from adj_entry_list`);
                        // Example: Delete rows from adj_entry_list where period matches column name
                        yield pool.query(`DELETE FROM adj_entry_list WHERE period = '${col}'`);
                    }
                    console.log(`Dropping column ${col} from ${tableName}`); // Debug log
                    yield pool.query(`ALTER TABLE "${tableName}" DROP COLUMN IF EXISTS "${col}"`);
                    console.log(`Re-adding column ${col} to ${tableName}`); // Debug log
                    yield pool.query(`ALTER TABLE "${tableName}" ADD COLUMN "${col}" TEXT`);
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
// /**
//  * Ensures adj_entry_list table exists
//  */
// async function ensureAdjEntryTable() {
//   const createTableSQL = `
//     CREATE TABLE IF NOT EXISTS adj_entry_list (
//       id SERIAL PRIMARY KEY,
//       hash_val TEXT NOT NULL,
//       "glAccount" TEXT NOT NULL,
//       "glName" TEXT NOT NULL,
//       "period" TEXT NOT NULL,
//       "amount" NUMERIC NOT NULL,
//       "narration" TEXT,
//       "status" TEXT DEFAULT 'pending',
//       "entry_type" TEXT DEFAULT 'manual',
//       "created_at" TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
//       "approved_at" TIMESTAMP NULL,
//       "approved_by" TEXT NULL
//     );
//   `;
//   await pool.query(createTableSQL);
// }
// ensureAdjEntryTable().catch(console.error);
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
                .map(col => `"${col}" = COALESCE(${tableName}."${col}", EXCLUDED."${col}")`)
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
app.post("/api/data", (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    const { finalMappedData, overwrite } = req.body;
    console.log("Received overwrite flag:", overwrite);
    if (!finalMappedData || finalMappedData.length === 0) {
        return res.status(400).send('No data received');
    }
    const exclude = ['accountType', 'Level 1 Desc', 'Level 2 Desc', 'functionalArea'];
    const transformedData = finalMappedData.map((row) => {
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
        const trialBalanceDuplicates = yield ensureTable("trial_balance", finalMappedData[0], overwrite !== null && overwrite !== void 0 ? overwrite : false);
        const adjustmentEntriesDuplicates = yield ensureTable("adjustment_entries", transformedData[0], overwrite !== null && overwrite !== void 0 ? overwrite : false);
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
        yield upsertRows('trial_balance', finalMappedData);
        yield upsertRows('adjustment_entries', transformedData);
        res.status(200).send('Both mappedData and transformedData inserted/updated successfully');
    }
    catch (error) {
        console.error(error);
        res.status(500).send('Error inserting/updating data');
    }
}));
app.get('/api/data', (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    try {
        const data = yield pool.query(`SELECT DISTINCT "glAccount", "glName","Level 1 Desc","Level 2 Desc" FROM trial_balance ORDER BY "glAccount"`);
        const data1 = data.rows; // Get all rows directly
        res.json(data1); // Send all data as JSON
    }
    catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
}));
/**
 * @route POST /api/financialvar-updated
 */
app.post('/api/financialvar-updated', (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    const { financialVar1, overwrite } = req.body;
    if (!financialVar1 || financialVar1.length === 0) {
        return res.status(400).send('No data received');
    }
    try {
        yield ensureTable('financial_variables1', financialVar1[0], overwrite !== null && overwrite !== void 0 ? overwrite : false);
        yield upsertRowsWithKey('financial_variables1', financialVar1);
        res.status(200).send('financialVar inserted/updated successfully');
    }
    catch (error) {
        console.error(error);
        res.status(500).send('Error inserting/updating data');
    }
}));
app.post('/api/text-variables', (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    const { textVar1, overwrite } = req.body;
    if (!textVar1 || textVar1.length === 0) {
        return res.status(400).send('No data received');
    }
    try {
        yield ensureTable('text_keys1', textVar1[0], overwrite !== null && overwrite !== void 0 ? overwrite : false);
        yield upsertRowsWithKey('text_keys1', textVar1);
        res.status(200).send('textVar inserted/updated successfully');
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
    const { entries, narration, createdBy } = req.body;
    if (!Array.isArray(entries) || entries.length === 0) {
        return res.status(400).json({ msg: 'Invalid request body. Expected an array of entries.' });
    }
    const narrationText = typeof narration === 'string' && narration.trim() !== ''
        ? narration.trim()
        : 'No narration provided';
    const client = yield pool.connect();
    const hashVal = crypto_1.default.randomBytes(8).toString('hex');
    try {
        yield client.query('BEGIN');
        for (const entry of entries) {
            const { glAccount, period, value } = entry;
            if (!glAccount || !period || value === undefined)
                continue;
            const glRes = yield client.query(`SELECT "glName" FROM ${TABLE_NAME} WHERE "glAccount" = $1`, [glAccount]);
            const glName = ((_a = glRes.rows[0]) === null || _a === void 0 ? void 0 : _a.glName) || '';
            yield client.query(`INSERT INTO adj_entry_list (hash_val, "glAccount", "glName", "period", "amount", "status", "entry_type","narration", "created_by")
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`, [hashVal, glAccount, glName, period, value, 'pending', 'manual', narrationText, createdBy]);
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
app.post('/api/journal/batch-update', (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    var _a;
    const { entries, narration, createdBy } = req.body;
    if (!Array.isArray(entries) || entries.length === 0) {
        return res.status(400).json({ msg: 'Invalid request body. Expected an array of entries.' });
    }
    const narrationText = typeof narration === 'string' && narration.trim() !== ''
        ? narration.trim()
        : 'No narration provided';
    const client = yield pool.connect();
    const hashVal = crypto_1.default.randomBytes(8).toString('hex');
    try {
        yield client.query('BEGIN');
        for (const entry of entries) {
            const { glAccount, period, value } = entry;
            if (!glAccount || !period || value === undefined)
                continue;
            const glRes = yield client.query(`SELECT "glName" FROM ${TABLE_NAME} WHERE "glAccount" = $1`, [glAccount]);
            const glName = ((_a = glRes.rows[0]) === null || _a === void 0 ? void 0 : _a.glName) || '';
            // FIX 2: Removed extra closing parenthesis before VALUES
            yield client.query(`INSERT INTO adj_entry_list (hash_val, "glAccount", "glName", "period", "amount", "status", "entry_type", "narration", "created_by") 
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`, [hashVal, glAccount, glName, period, value, 'pending', 'manual', narrationText, createdBy]);
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
// Reject entries
app.get('/api/journal/entries', (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    try {
        const { period, user } = req.query;
        if (!period) {
            const periodsResult = yield pool.query(`SELECT DISTINCT "period" FROM adj_entry_list ORDER BY "period"`);
            return res.json({ periods: periodsResult.rows.map(r => r.period) });
        }
        // FIX 1: Expanded the SELECT statement to include all necessary status columns.
        let queryText = `
        SELECT 
            hash_val, "glAccount", "glName", "period", "amount", "narration",
            "status", "created_by", "approved_by", "approved_at", "rejected_by", 
            "rejected_at", "admin_comments"
        FROM adj_entry_list 
        WHERE "period" = $1
    `;
        const queryParams = [period];
        if (user) {
            queryText += ` AND "created_by" = $2`;
            queryParams.push(user);
        }
        queryText += ` ORDER BY hash_val, "created_at" DESC`;
        const entriesResult = yield pool.query(queryText, queryParams);
        res.json({ entries: entriesResult.rows });
    }
    catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error while fetching entries');
    }
}));
app.post('/api/journal/reject-entries', (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    const { entryIds, rejectedBy = 'admin', narration } = req.body;
    const narrationText = typeof narration === 'string' && narration.trim() !== ''
        ? narration.trim()
        : 'No narration provided';
    if (!Array.isArray(entryIds) || entryIds.length === 0) {
        return res.status(400).json({ msg: 'Invalid request body. Expected an array of entry IDs.' });
    }
    try {
        const placeholders = entryIds.map((_, i) => `$${i + 3}`).join(',');
        const result = yield pool.query(`UPDATE adj_entry_list 
       SET "status" = 'rejected', "rejected_at" = CURRENT_TIMESTAMP, "rejected_by" = $1, "admin_comments" = $2
       WHERE id IN (${placeholders}) AND "status" = 'pending'`, [rejectedBy, narrationText, ...entryIds]);
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
app.post('/api/journal/approve-entries', (req, res) => __awaiter(void 0, void 0, void 0, function* () {
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
        const approveResult = yield pool.query(`UPDATE adj_entry_list 
       SET "status" = 'approved', "approved_at" = CURRENT_TIMESTAMP, "approved_by" = $1, "admin_comments" = $2
       WHERE id IN (${placeholders})`, [approvedBy, narrationText, ...entryIds]);
        // Step 2: Get distinct periods from approved entries
        const periodsResult = yield pool.query(`SELECT DISTINCT period 
       FROM adj_entry_list
       WHERE id = ANY($1::int[]) AND status = 'approved'`, [entryIds]);
        const periods = periodsResult.rows.map((r) => r.period);
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
            yield pool.query(dynamicQuery, [entryIds]);
        }
        res.json({
            msg: 'Entries approved and adjustment_entries updated successfully',
            approvedCount: approveResult.rowCount
        });
    }
    catch (err) {
        console.error('Approve failed:', err.message);
        res.status(500).send('Server Error during approval process');
    }
}));
// Get all pending entries for admin approval
app.get('/api/journal/pending-entries', (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    try {
        const entriesResult = yield pool.query(`SELECT id, hash_val, "glAccount", "glName", "period", "amount", "entry_type", "created_at", "narration", "created_by"
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
/**
 * @route GET /api/journal/entries
 */
app.get('/api/journal/entries', (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    try {
        const { period, user } = req.query;
        if (!period) {
            const periodsResult = yield pool.query(`SELECT DISTINCT "period" FROM adj_entry_list ORDER BY "period"`);
            return res.json({ periods: periodsResult.rows.map(r => r.period) });
        }
        let queryText = `
        SELECT 
            j.hash_val, j."glAccount", j."glName", j."period", j."amount", j."narration",
            j."status", j."created_by", u.name as creator_name, j."approved_by", j."approved_at", j."rejected_by", 
            j."rejected_at", j."admin_comments"
        FROM adj_entry_list j
        LEFT JOIN users u ON j.created_by = u.username
        WHERE j."period" = $1
    `;
        const queryParams = [period];
        if (user) {
            queryText += ` AND j."created_by" = $2`; // Filter by the creator's username/email
            queryParams.push(user);
        }
        queryText += ` ORDER BY j.hash_val, j."created_at" DESC`;
        const entriesResult = yield pool.query(queryText, queryParams);
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
            const query = `
        UPDATE financial_variables1
        SET ${setClauses}
        WHERE key = $1
      `;
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
            const query = `
        UPDATE text_keys1
        SET ${setClauses}
        WHERE key = $1
      `;
            yield pool.query(query, values);
        }
        res.status(200).json({ message: 'Update successful' });
    }
    catch (error) {
        console.error('Error updating:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
}));
app.get('/api/text_keys1', (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    try {
        const updatedtext_keys = yield pool.query('SELECT * FROM text_keys1');
        const updatedtext_keys1 = updatedtext_keys.rows; // Get all rows directly
        res.json(updatedtext_keys1); // Send all data as JSON
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
/**
 * @route POST /api/auth/register
 * @desc  Register a new user
 */
app.post('/api/auth/register', (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    console.log("--- Received request to /api/auth/register ---");
    console.log("Request Body:", req.body);
    const { name, email, password, mobile, company, role: requestedRole = 'user' } = req.body;
    const username = email; // We use email as the unique identifier
    if (!username || !password || !name) {
        return res.status(400).json({ msg: 'Please provide name, email, and password.' });
    }
    if (requestedRole !== 'user' && requestedRole !== 'admin') {
        return res.status(400).json({ msg: 'Invalid role specified.' });
    }
    try {
        console.log(`Checking if user '${username}' already exists...`);
        const userExists = yield pool.query('SELECT * FROM users WHERE username = $1', [username]);
        if (userExists.rows.length > 0) {
            console.warn(`Registration failed: User '${username}' already exists.`);
            return res.status(409).json({ msg: 'A user with this email already exists.' });
        }
        console.log(`User '${username}' does not exist. Proceeding with registration.`);
        console.log("Hashing password...");
        const salt = yield bcryptjs_1.default.genSalt(10);
        const password_hash = yield bcryptjs_1.default.hash(password, salt);
        console.log("Password hashed successfully.");
        // Make the very first user an admin by default
        const userCountResult = yield pool.query('SELECT COUNT(*) FROM users');
        const isFirstUser = parseInt(userCountResult.rows[0].count, 10) === 0;
        const finalRole = isFirstUser ? 'admin' : requestedRole;
        console.log("Attempting to insert new user into the database...");
        const insertQuery = `
    INSERT INTO users (username, password_hash, role, name, mobile, company) 
    VALUES ($1, $2, $3, $4, $5, $6) 
    RETURNING id
`;
        // This is the array that was missing. It provides the actual values.
        const values = [
            username,
            password_hash,
            finalRole,
            name,
            mobile,
            company
        ];
        const newUserResult = yield pool.query(insertQuery, values);
        console.log("SUCCESS: New user inserted with ID:", newUserResult.rows[0].id);
        res.status(201).json({ msg: 'Registration successful! You can now log in.' });
    }
    catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error during registration');
    }
}));
/**
 * @route POST /api/auth/login
 * @desc  Authenticate a user and return a token
 */
app.post('/api/auth/login', (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    const jwtSecret = process.env.JWT_SECRET;
    if (!jwtSecret) {
        console.error("!!!!!!!!!! FATAL ERROR !!!!!!!!!!");
        console.error("JWT_SECRET is not defined in the environment variables.");
        console.error("Please ensure the .env file is correctly formatted and loaded.");
        return res.status(500).send('Server configuration error: Missing JWT secret.');
    }
    console.log("\n--- Received request to /api/auth/login ---");
    console.log("Request Body:", req.body);
    const { username, password } = req.body; // Frontend sends email as username
    if (!username || !password) {
        console.error("Login failed: Missing username or password.");
        return res.status(400).json({ msg: 'Please provide email and password.' });
    }
    try {
        console.log(`Searching for user: '${username}' in the database...`);
        const result = yield pool.query('SELECT * FROM users WHERE username = $1', [username]);
        const user = result.rows[0];
        if (!user) {
            console.warn(`Login failed: User '${username}' not found.`);
            return res.status(401).json({ msg: 'Invalid username or password.' });
        }
        console.log(`User found:`, { id: user.id, username: user.username, role: user.role });
        console.log("Comparing submitted password with stored hash...");
        const isMatch = yield bcryptjs_1.default.compare(password, user.password_hash);
        if (!isMatch) {
            console.warn(`Login failed: Password does not match for user '${username}'.`);
            return res.status(401).json({ msg: 'Invalid username or password.' });
        }
        console.log("Password is a match!");
        const payload = { userId: user.id, username: user.username, role: user.role };
        const token = jsonwebtoken_1.default.sign(payload, jwtSecret, { expiresIn: '8h' });
        console.log("JWT token created successfully.");
        console.log("Sending successful login response to client.");
        res.json({ token, user: { username: user.username, role: user.role } });
    }
    catch (err) {
        console.error("An unexpected error occurred during login:", err.message);
        res.status(500).send('Server Error during login');
    }
}));
app.get('/api/notes/status', (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    const { periodKey } = req.query;
    if (!periodKey || typeof periodKey !== 'string') {
        return res.status(400).json({ msg: 'A periodKey query parameter is required.' });
    }
    try {
        const result = yield pool.query('SELECT note_number FROM note_edit_status WHERE period_key = $1 AND is_edited = TRUE', [periodKey]);
        const editedNotes = result.rows.map(row => row.note_number);
        res.status(200).json({ editedNotes });
    }
    catch (err) {
        console.error('Error fetching note statuses:', err.message);
        res.status(500).send('Server Error');
    }
}));
app.post('/api/notes/status', (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    const { noteNumbers, periodKey } = req.body;
    if (!Array.isArray(noteNumbers) || !periodKey) {
        return res.status(400).json({ msg: 'Invalid request body. Expected noteNumbers (array) and periodKey (string).' });
    }
    if (noteNumbers.length === 0) {
        return res.status(200).json({ msg: 'No notes to update.' });
    }
    const client = yield pool.connect();
    try {
        yield client.query('BEGIN');
        for (const noteNumber of noteNumbers) {
            const query = `
                INSERT INTO note_edit_status (note_number, period_key, is_edited, last_edited_at)
                VALUES ($1, $2, TRUE, CURRENT_TIMESTAMP)
                ON CONFLICT (note_number, period_key)
                DO UPDATE SET
                    is_edited = TRUE,
                    last_edited_at = CURRENT_TIMESTAMP;
            `;
            yield client.query(query, [String(noteNumber), periodKey]);
        }
        yield client.query('COMMIT');
        res.status(200).json({ msg: 'Note statuses updated successfully.' });
    }
    catch (err) {
        yield client.query('ROLLBACK');
        console.error('Error updating note statuses:', err.message);
        res.status(500).send('Server Error');
    }
    finally {
        client.release();
    }
}));
// Start server
app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
