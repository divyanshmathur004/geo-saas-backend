const express = require('express');
const errorHandler = require('./middleware/errorHandler');
const searchRoutes = require('./routes/search');
const ApiResponse = require('./utils/apiResponse');

const app = express();

// Global Middlewares
app.use(express.json());

// Health Check
app.get('/health', (req, res) => {
  return ApiResponse.success(res, { status: 'healthy', timestamp: new Date() }, 'API is running');
});

// API Routes
app.use('/api/search', searchRoutes);
app.use('/api/v1/search', searchRoutes);

// 404 Handler
app.use((req, res) => {
  return ApiResponse.error(res, 'Route not found', 404);
});

// Global Error Handler must be the last middleware
app.use(errorHandler);

module.exports = app;
