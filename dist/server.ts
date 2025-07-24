import express from 'express';
import cors from 'cors';
import bodyParser from 'body-parser';
import { Pool } from 'pg';

const app = express();
app.use(cors());
app.use(bodyParser.json({ limit: '100mb' }));
app.use(express.json({ limit: "100mb" }));
app.use(express.urlencoded({ limit: "100mb", extended: true }));

const pool = new Pool({
  user: 'postgres',
  host: 'localhost',
  database: 'Y_Finance',
  password: 'password1A',
  port: 5432,
});

app.post('/api/data', async (req, res) => {
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
    await pool.query(createTableSQL);

    // Insert each row
    for (const row of mappedData) {
      const rowColumns = Object.keys(row);
      const values = Object.values(row);

      // Always quote column names in INSERT
      const colNames = rowColumns.map(col => `"${col}"`).join(', ');
      const paramPlaceholders = rowColumns.map((_, i) => `$${i + 1}`).join(', ');

      const sql = `INSERT INTO mapped_rows (${colNames}) VALUES (${paramPlaceholders})`;

      await pool.query(sql, values);
    }
    res.status(200).send('Data inserted');
  } catch (error) {
    console.error(error);
    res.status(500).send('Error inserting data');
  }
});

app.listen(5000, () => {
  console.log('Server running on http://localhost:5000');
});