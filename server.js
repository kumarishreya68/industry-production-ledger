const express = require('express');
const { Pool } = require('pg');
const path = require('path');
const app = express();
const port = 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Connect to your local PostgreSQL Database
const pool = new Pool({
    user: 'postgres',              
    host: 'localhost',
    database: 'industry_production_db',
    password: '01022005', 
    port: 5432,
});

// SIMULATOR: Clear baselines + Integrated live status array tracking
let liveMachineData = {
    good_output: 100,
    reject_count: 2,
    downtime_minutes: 4,
    stop_reason: 'Pending Action...',
    timeline: [] // Tracks 'normal', 'defect', or 'downtime' status bars
};

// Background routine: Simulation engine running every 3 seconds
setInterval(() => {
    // Keep timeline limited to the last 40 entries so it scales perfectly on the dashboard
    if (liveMachineData.timeline.length > 40) {
        liveMachineData.timeline.shift();
    }

    // 1. Good parts count up fast and steady
    liveMachineData.good_output += Math.floor(Math.random() * 15) + 5; 

    // 2. Independent Probabilities for Alarms & Normal Metrics
    const rand = Math.random();
    if (rand > 0.90) {
        // 10% chance: Critical Downtime Handoff Stop
        liveMachineData.downtime_minutes += Math.floor(Math.random() * 4) + 1; 
        liveMachineData.timeline.push('downtime');
    } else if (rand > 0.75) {
        // 15% chance: Vision Cam Reject Defect Pulse
        liveMachineData.reject_count += Math.floor(Math.random() * 2) + 1; 
        liveMachineData.timeline.push('defect');
    } else {
        // 75% chance: Optimal standard cycle
        liveMachineData.timeline.push('normal');
    }
}, 3000);

// API 1: Expose numbers and timeline state to dashboard
app.get('/api/machine-data', (req, res) => {
    res.json(liveMachineData);
});

// API 2: Submit shift verification sign-off data to Postgres
app.post('/api/verify-shift', async (req, res) => {
    let { operator_name, stop_reason } = req.body;
    
    if (!stop_reason || stop_reason === "Pending Verification...") {
        stop_reason = "Uncategorized Error";
    }

    try {
        const stringifiedTimeline = JSON.stringify(liveMachineData.timeline);

        // CLEAN SQL PARAMETERS WITHOUT BACKSLASHES
        await pool.query(
            'INSERT INTO shift_logs (operator_name, good_output, reject_count, downtime_minutes, stop_reason, is_verified, timeline_data) VALUES (\$1, \$2, \$3, \$4, \$5, \$6, \$7)',
            [operator_name, liveMachineData.good_output, liveMachineData.reject_count, liveMachineData.downtime_minutes, stop_reason, true, stringifiedTimeline]
        );
        
        // Reset the live counters back to clean baselines for the next running shift
        liveMachineData = { good_output: 0, reject_count: 0, downtime_minutes: 0, stop_reason: 'Pending Action...', timeline: [] };
        res.json({ success: true, message: 'Shift verified and committed to ledger!' });
    } catch (err) {
        console.error("Database Insert Error:", err);
        res.status(500).json({ error: 'Database saving failed' });
    }
});

// API 3: Query history records data rows table
app.get('/api/history', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM shift_logs ORDER BY created_at DESC');
        res.json(result.rows);
    } catch (err) {
        console.error("Fetch History Error:", err);
        res.status(500).json({ error: 'Failed to fetch history data' });
    }
});

app.listen(port, () => console.log(`Server running perfectly at http://localhost:${port}`));
