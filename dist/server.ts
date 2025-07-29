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
  const { mappedData } = req.body as { mappedData: Record<string, any>[] }; 
  if (!mappedData || mappedData.length === 0) {
    return res.status(400).send('No data received');
  }

  const exclude = ['createdby', 'accountType', 'Level 1 Desc', 'Level 2 Desc', 'functionalArea'];

  // 1️⃣ Create transformed data with proper typing
  const transformedData = mappedData.map((row: Record<string, any>) => {
    const newRow: Record<string, any> = {};

    Object.keys(row).forEach((key) => {
      if (!exclude.includes(key)) {
        if (key === 'glAccount') {
          newRow[key] = row[key]; 
        } else {
          newRow[key] = 0; 
        }
      }
    });

    return newRow;
  });

  try {
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


app.listen(5000, () => {
  console.log('Server running on http://localhost:5000');
});