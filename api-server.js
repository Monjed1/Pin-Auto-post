require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const { postToPinterest } = require('./index');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(bodyParser.json());

// Health check endpoint
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'healthy', message: 'Pinterest API server is running' });
});

// Main API endpoint to receive post data
app.post('/api/pinterest/post', async (req, res) => {
  try {
    console.log('Received request with payload:', JSON.stringify(req.body));
    
    // Validate required fields
    if (!req.body.imageUrl || !req.body.title) {
      return res.status(400).json({ 
        success: false, 
        error: 'Missing required fields (imageUrl and title are required)'
      });
    }
    
    // Process the request asynchronously to avoid timeout
    res.status(202).json({ 
      success: true, 
      message: 'Pinterest post request accepted and being processed'
    });
    
    // Execute the Pinterest posting in the background
    postToPinterest(req.body)
      .then(() => {
        console.log('Pinterest post completed successfully');
      })
      .catch(error => {
        console.error('Error posting to Pinterest:', error.message);
      });
      
  } catch (error) {
    console.error('Error processing request:', error);
    // Since we've already sent a response, we just log the error
  }
});

// Start the server
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Pinterest API server running on http://0.0.0.0:${PORT}`);
}); 