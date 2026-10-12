require('dotenv').config();

const express = require('express');
const { Pool } = require('pg');
const path = require('path');

const app = express();
const port = Number(process.env.PORT) || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const pool = new Pool({
    user: process.env.PGUSER || 'postgres',
    host: process.env.PGHOST || 'localhost',
    database: process.env.PGDATABASE || 'industry_production_db',
    password: process.env.PGPASSWORD,
    port: Number(process.env.PGPORT) || 5432
});

pool.on('error', (err) => {
    console.error('PostgreSQL pool error:', err.message);
});

const liveMachineData = {
    good_output: 100,
    reject_count: 2,
    downtime_minutes: 4,
    stop_reason: 'Pending Action...',
    timeline: []
};

let activeShiftId = null;
let eventQueue = Promise.resolve();

function snapshot() {
    return {
        good_output: liveMachineData.good_output,
        reject_count: liveMachineData.reject_count,
        downtime_minutes: liveMachineData.downtime_minutes
    };
}

function shiftDelta(end, start) {
    return Math.max(0, Number(end) - Number(start));
}

// Store machine state in the existing machine_events table.
// Every event captures a state snapshot so it can be restored after restart.
function recordMachineEvent(type, details, shiftId = activeShiftId) {
    const stateDetails = JSON.stringify({
        message: details,
        state: snapshot(),
        timeline: liveMachineData.timeline
    });

    eventQueue = eventQueue
        .then(() => pool.query(
            `INSERT INTO machine_events
                (shift_id, event_type, occurred_at, details)
             VALUES ($1, $2, CURRENT_TIMESTAMP, $3)`,
            [shiftId, type, stateDetails]
        ))
        .catch((err) => {
            console.error('Machine event save failed:', err.message);
        });

    return eventQueue;
}

// Restore the most recently saved machine counters after a server restart.
async function restoreMachineState() {
    const result = await pool.query(
        `SELECT details
         FROM machine_events
         WHERE details LIKE '{"message"%'
         ORDER BY occurred_at DESC, id DESC
         LIMIT 1`
    );

    if (result.rows.length === 0) {
        return;
    }

    try {
        const saved = JSON.parse(result.rows[0].details);

        if (saved.state) {
            liveMachineData.good_output = Number(saved.state.good_output);
            liveMachineData.reject_count = Number(saved.state.reject_count);
            liveMachineData.downtime_minutes =
                Number(saved.state.downtime_minutes);
        }

        if (Array.isArray(saved.timeline)) {
            liveMachineData.timeline = saved.timeline.slice(-40);
        }
    } catch (err) {
        console.error('Could not restore saved machine state:', err.message);
    }
}

// The simulator continues running regardless of shift status.
setInterval(() => {
    const rand = Math.random();
    let eventType = 'normal';
    let description = 'Machine production update';

    liveMachineData.good_output += Math.floor(Math.random() * 2) + 1;

    // Occasionally add downtime event add one minute
    if (rand > 0.98) {
        liveMachineData.downtime_minutes += 1;
        eventType = 'downtime';
        description = 'Simulated downtime';
    } //Occasional defect: add one rejected unit
    else if (rand > 0.75) {
        liveMachineData.reject_count += 1;
        eventType = 'defect';
        description = 'Simulated production defect';
    }

    liveMachineData.timeline.push(eventType);

    if (liveMachineData.timeline.length > 40) {
        liveMachineData.timeline.shift();
    }

    // Continue reading snapshots and machine events.
    recordMachineEvent(eventType, description, activeShiftId);
}, 10000);

app.get('/api/health', async (req, res) => {
    try {
        await pool.query('SELECT 1');
        res.json({ success: true, database: 'connected' });
    } catch (err) {
        res.status(503).json({
            success: false,
            database: 'unavailable'
        });
    }
});

app.get('/api/machine-data', (req, res) => {
    res.json({
        ...liveMachineData,
        active_shift_id: activeShiftId
    });
});

app.get('/api/shifts/current', async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT *
             FROM production_shifts
             WHERE status = 'running'
             ORDER BY started_at DESC
             LIMIT 1`
        );

        res.json(result.rows[0] || null);
    } catch (err) {
        console.error(err.message);
        res.status(500).json({ error: 'Failed to fetch current shift' });
    }
});

// Start a shift using the current cumulative counter values.
app.post('/api/shifts/start', async (req, res) => {
    const client = await pool.connect();

    try {
        await client.query('BEGIN');

        const counters = snapshot();

        const result = await client.query(
            `INSERT INTO production_shifts (
                status,
                start_good_output,
                start_reject_count,
                start_downtime_minutes
             )
             VALUES ('running', $1, $2, $3)
             RETURNING *`,
            [
                counters.good_output,
                counters.reject_count,
                counters.downtime_minutes
            ]
        );

        await client.query('COMMIT');

        activeShiftId = result.rows[0].id;

        await recordMachineEvent(
            'normal',
            `Shift ${activeShiftId} started`,
            activeShiftId
        );

        res.status(201).json({
            success: true,
            message: 'Shift started',
            shift: result.rows[0]
        });
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});

        if (err.code === '23505') {
            return res.status(409).json({
                error: 'A shift is already running'
            });
        }

        console.error('Start shift failed:', err.message);
        res.status(500).json({ error: 'Failed to start shift' });
    } finally {
        client.release();
    }
});

// End a shift. Live counters are never reset.
app.post('/api/shifts/:id/end', async (req, res) => {
    const shiftId = req.params.id;

    if (!/^\d+$/.test(shiftId)) {
        return res.status(400).json({ error: 'Invalid shift ID' });
    }

    const client = await pool.connect();

    try {
        await client.query('BEGIN');

        const found = await client.query(
            `SELECT *
             FROM production_shifts
             WHERE id = $1
             FOR UPDATE`,
            [shiftId]
        );

        if (found.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'Shift not found' });
        }

        const shift = found.rows[0];

        if (shift.status !== 'running') {
            await client.query('ROLLBACK');
            return res.status(409).json({
                error: 'This shift has already ended'
            });
        }

        if (String(activeShiftId) !== String(shiftId)) {
            await client.query('ROLLBACK');
            return res.status(409).json({
                error: 'This is not the active simulated shift'
            });
        }

        const counters = snapshot();

        const totals = {
            good_output: shiftDelta(
                counters.good_output,
                shift.start_good_output
            ),
            reject_count: shiftDelta(
                counters.reject_count,
                shift.start_reject_count
            ),
            downtime_minutes: shiftDelta(
                counters.downtime_minutes,
                shift.start_downtime_minutes
            )
        };

        const updated = await client.query(
            `UPDATE production_shifts
             SET status = 'ended',
                 ended_at = CURRENT_TIMESTAMP,
                 end_good_output = $2,
                 end_reject_count = $3,
                 end_downtime_minutes = $4,
                 good_output = $5,
                 reject_count = $6,
                 downtime_minutes = $7,
                 timeline_data = $8::jsonb
             WHERE id = $1
             RETURNING *`,
            [
                shiftId,
                counters.good_output,
                counters.reject_count,
                counters.downtime_minutes,
                totals.good_output,
                totals.reject_count,
                totals.downtime_minutes,
                JSON.stringify(liveMachineData.timeline)
            ]
        );

        await client.query('COMMIT');

        activeShiftId = null;

        await recordMachineEvent(
            'normal',
            `Shift ${shiftId} ended`,
            null
        );

        res.json({
            success: true,
            message: 'Shift ended; machine continues running',
            shift: updated.rows[0]
        });
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        console.error('End shift failed:', err.message);
        res.status(500).json({ error: 'Failed to end shift' });
    } finally {
        client.release();
    }
});

// Verify a particular ended shift.
async function verifyShift(shiftId, body, res) {
    const operatorName =
        typeof body.operator_name === 'string'
            ? body.operator_name.trim()
            : '';

    const stopReason =
        typeof body.stop_reason === 'string'
            ? body.stop_reason.trim()
            : '';

    if (!operatorName || operatorName.length > 100) {
        return res.status(400).json({
            error: 'Enter an operator name (maximum 100 characters)'
        });
    }

    if (!stopReason || stopReason.length > 255) {
        return res.status(400).json({
            error: 'Enter a stoppage reason (maximum 255 characters)'
        });
    }

    const client = await pool.connect();

    try {
        await client.query('BEGIN');

        const found = await client.query(
            `SELECT *
             FROM production_shifts
             WHERE id = $1
             FOR UPDATE`,
            [shiftId]
        );

        if (found.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'Shift not found' });
        }

        if (found.rows[0].status !== 'ended') {
            await client.query('ROLLBACK');
            return res.status(409).json({
                error: 'Only ended shifts can be verified'
            });
        }

        const result = await client.query(
            `UPDATE production_shifts
             SET status = 'verified',
                 verified_at = CURRENT_TIMESTAMP,
                 operator_name = $2,
                 stop_reason = $3
             WHERE id = $1
             RETURNING *`,
            [shiftId, operatorName, stopReason]
        );

        const shift = result.rows[0];

        await client.query(
            `INSERT INTO shift_logs (
                operator_name,
                good_output,
                reject_count,
                downtime_minutes,
                stop_reason,
                is_verified,
                timeline_data
             )
             VALUES ($1, $2, $3, $4, $5, TRUE, $6)`,
            [
                shift.operator_name,
                shift.good_output,
                shift.reject_count,
                shift.downtime_minutes,
                shift.stop_reason,
                JSON.stringify(shift.timeline_data)
            ]
        );

        await client.query('COMMIT');

        await recordMachineEvent(
            'normal',
            `Shift ${shiftId} verified`,
            null
        );

        return res.json({
            success: true,
            message: 'Shift verified and saved to the ledger',
            shift
        });
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        console.error('Verify shift failed:', err.message);
        return res.status(500).json({ error: 'Failed to verify shift' });
    } finally {
        client.release();
    }
}

app.post('/api/shifts/:id/verify', (req, res) => {
    if (!/^\d+$/.test(req.params.id)) {
        return res.status(400).json({ error: 'Invalid shift ID' });
    }

    return verifyShift(req.params.id, req.body, res);
});

// Temporary compatibility route for the old frontend.
// It verifies the most recent ended shift.
app.post('/api/verify-shift', async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT id
             FROM production_shifts
             WHERE status = 'ended'
             ORDER BY ended_at DESC
             LIMIT 1`
        );

        if (result.rows.length === 0) {
            return res.status(409).json({
                error: 'End a shift before verifying it'
            });
        }

        return verifyShift(
            String(result.rows[0].id),
            req.body,
            res
        );
    } catch (err) {
        console.error(err.message);
        return res.status(500).json({
            error: 'Could not find an ended shift'
        });
    }
});

app.get('/api/shifts', async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT *
             FROM production_shifts
             ORDER BY started_at DESC`
        );

        res.json(result.rows);
    } catch (err) {
        console.error(err.message);
        res.status(500).json({ error: 'Failed to fetch shifts' });
    }
});

app.get('/api/machine-events', async (req, res) => {
    try {
        const requestedLimit =
            Number.parseInt(req.query.limit, 10) || 40;

        const limit = Math.min(
            100,
            Math.max(1, requestedLimit)
        );

        const result = await pool.query(
            `SELECT
                id,
                shift_id,
                event_type,
                occurred_at,
                duration_minutes,
                details
             FROM machine_events
             ORDER BY occurred_at DESC, id DESC
             LIMIT $1`,
            [limit]
        );

        res.json({
            success: true,
            events: result.rows
        });
    } catch (error) {
        console.error(
            'Error fetching machine events:',
            error
        );

        res.status(500).json({
            success: false,
            message: 'Unable to fetch machine events'
        });
    }
});
app.get('/api/shifts/:id/events', async (req, res) => {
    if (!/^\d+$/.test(req.params.id)) {
        return res.status(400).json({ error: 'Invalid shift ID' });
    }

    try {
        const result = await pool.query(
            `SELECT *
             FROM machine_events
             WHERE shift_id = $1
             ORDER BY occurred_at ASC, id ASC`,
            [req.params.id]
        );

        res.json(result.rows);
    } catch (err) {
        console.error(err.message);
        res.status(500).json({ error: 'Failed to fetch machine events' });
    }
});

app.get('/api/history', async (req, res) => {
    try {
        const result = await pool.query(
            'SELECT * FROM shift_logs ORDER BY created_at DESC'
        );

        res.json(result.rows);
    } catch (err) {
        console.error(err.message);
        res.status(500).json({ error: 'Failed to fetch history' });
    }
});

async function startServer() {
    try {
        await pool.query('SELECT 1');
        await restoreMachineState();

        const running = await pool.query(
            `SELECT id
             FROM production_shifts
             WHERE status = 'running'
             ORDER BY started_at DESC
             LIMIT 1`
        );

        if (running.rows.length > 0) {
            activeShiftId = running.rows[0].id;
            console.log(`Recovered running shift ${activeShiftId}`);
        }

        app.listen(port, () => {
            console.log('Connected to PostgreSQL');
            console.log(`Server running at http://localhost:${port}`);
        });
    } catch (err) {
        console.error('Server startup failed:', err.message);
        process.exit(1);
    }
}

startServer();