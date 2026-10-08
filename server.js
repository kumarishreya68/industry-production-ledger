const express = require('express');
const { Pool } = require('pg');
const path = require('path');
const app = express();
const port = 3000;

app.use(express.json());
// Serve the static frontend HTML files automatically
app.use(express.static(path.join(__dirname, 'public')));

// Connect to your local PostgreSQL Database
const pool = new Pool({
    user: 'postgres',              // Change this to your local Postgres username
    host: 'localhost',
    database: 'industry_production_db',
    password: 'yourpassword',      // Change this to your local Postgres password
    port: 5432,
});

// SIMULATOR: Temporary object mimicking the live machine's sensors right now
let liveMachineData = {
    good_output: 100,
    reject_count: 2,
    downtime_minutes: 0,
    stop_reason: 'Pending Action...'
};

// Background routine: Simulation engine increases parts automatically every 3 seconds
setInterval(() => {
    liveMachineData.good_output += Math.floor(Math.random() * 15) + 5; // Adds 5-20 parts
    if (Math.random() > 0.85) {
        liveMachineData.reject_count += 1; // 15% chance a reject occurs
        liveMachineData.downtime_minutes += 1; // Machine experiences downtime
    }
}, 3000);

// API 1: Frontend pulls this endpoint to get the latest live numbers
app.get('/api/machine-data', (req, res) => {
    res.json(liveMachineData);
});

// API 2: Operator submits this endpoint when they click buttons or verify the shift
app.post('/api/verify-shift', async (req, res) => {
    const { operator_name, stop_reason } = req.body;
    try {
        // Save the snapshot instantly into your PostgreSQL long-term ledger
        await pool.query(
            'INSERT INTO shift_logs (operator_name, good_output, reject_count, downtime_minutes, stop_reason, is_verified) VALUES (\$1, \$2, \$3, \$4, \$5, \$6)',
            [operator_name, liveMachineData.good_output, liveMachineData.reject_count, liveMachineData.downtime_minutes, stop_reason, true]
        );
        
        // Reset the live counters on the line for the next shift run
        liveMachineData = { good_output: 0, reject_count: 0, downtime_minutes: 0, stop_reason: 'Pending Action...' };
        res.json({ success: true, message: 'Shift verified and committed to ledger!' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Database saving failed' });
    }
});

// API 3: Fetches the historical log data table for the career dashboard
app.get('/api/history', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM shift_logs ORDER BY created_at DESC');
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: 'Failed to fetch history data' });
    }
});

app.listen(port, () => console.log(`Server running at http://localhost:${port}`));
