require('dotenv').config();
const express = require('express');
const cors = require('cors');

const environmentsRouter = require('./routes/environments');
const endpointsRouter = require('./routes/endpoints');
const dashboardRouter = require('./routes/dashboard');
const schedulesRouter = require('./routes/schedules');
const foldersRouter = require('./routes/folders');
const flowsRouter = require('./routes/flows');
const flowRunsRouter = require('./routes/flowRuns');
const authCredentialsRouter = require('./routes/authCredentials');
const defaultHeadersRouter = require('./routes/defaultHeaders');
const testFilesRouter = require('./routes/testFiles');
const settingsRouter = require('./routes/settings');
const jsonDiffRouter = require('./routes/jsonDiff');
const telegramRouter = require('./routes/telegram');
const stressTestRouter = require('./routes/stressTest');
const { initScheduler } = require('./services/scheduler');

const app = express();
app.use(cors());
// 20mb to leave headroom for base64-encoded file uploads attached to a
// flow step / endpoint body (base64 inflates size by ~33%).
app.use(express.json({ limit: '20mb' }));

app.use('/api/environments', environmentsRouter);
app.use('/api/endpoints', endpointsRouter);
app.use('/api/dashboard', dashboardRouter);
app.use('/api/schedules', schedulesRouter);
app.use('/api/folders', foldersRouter);
app.use('/api/flows', flowsRouter);
app.use('/api/flow-runs', flowRunsRouter);
app.use('/api/auth-credentials', authCredentialsRouter);
app.use('/api/default-headers', defaultHeadersRouter);
app.use('/api/test-files', testFilesRouter);
app.use('/api/settings', settingsRouter);
app.use('/api/json-diff', jsonDiffRouter);
app.use('/api/telegram', telegramRouter);
app.use('/api/stress-test', stressTestRouter);

app.get('/health', (req, res) => res.json({ status: 'ok' }));

// Global error handler — catches errors forwarded by catchAsync from any route,
// so one bad request returns a 500 instead of crashing the whole process.
app.use((err, req, res, next) => {
  console.error('[error]', err.message);
  res.status(500).json({ error: 'Internal server error', detail: err.message });
});

process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason);
});

const PORT = process.env.PORT || 4010;
app.listen(PORT, async () => {
  console.log(`QA Tool backend running on port ${PORT}`);
  try {
    await initScheduler();
  } catch (err) {
    console.error('[server] Failed to init scheduler:', err.message);
  }
});
