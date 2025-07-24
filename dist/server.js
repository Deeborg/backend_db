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
const app = (0, express_1.default)();
app.use((0, cors_1.default)());
app.use(body_parser_1.default.json({ limit: '100mb' }));
app.use(express_1.default.json({ limit: "100mb" }));
app.use(express_1.default.urlencoded({ limit: "100mb", extended: true }));
const pool = new pg_1.Pool({
    user: 'postgres',
    host: 'localhost',
    database: 'Y_Finance',
    password: 'password1A',
    port: 5432,
});
app.post('/api/data', (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    const { mappedData } = req.body;
    if (!mappedData || mappedData.length === 0) {
        return res.status(400).send('No data received');
    }
    // Get columns and types from the first row
    const firstRow = mappedData[0];
    const columns = Object.keys(firstRow);
    // Infer types: numbers as NUMERIC, others as TEXT
    const columnDefs = columns.map(col => {
        const value = firstRow[col];
        const type = typeof value === 'number' ? 'TEXT' : 'TEXT';
        return `"${col}" ${type}`;
    });
    const createTableSQL = `
    CREATE TABLE IF NOT EXISTS mapped_rows (
      id SERIAL PRIMARY KEY,
      ${columnDefs.join(',\n      ')}
    );
  `;
    try {
        yield pool.query(createTableSQL);
        // Insert each row
        for (const row of mappedData) {
            const rowColumns = Object.keys(row);
            const values = Object.values(row);
            // Always quote column names in INSERT
            const colNames = rowColumns.map(col => `"${col}"`).join(', ');
            const paramPlaceholders = rowColumns.map((_, i) => `$${i + 1}`).join(', ');
            const sql = `INSERT INTO mapped_rows (${colNames}) VALUES (${paramPlaceholders})`;
            yield pool.query(sql, values);
        }
        res.status(200).send('Data inserted');
    }
    catch (error) {
        console.error(error);
        res.status(500).send('Error inserting data');
    }
}));
app.listen(5000, () => {
    console.log('Server running on http://localhost:5000');
});
