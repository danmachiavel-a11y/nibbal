import express from 'express';
import { fileURLToPath } from 'url';
import path from 'path';
import fetch from 'node-fetch';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const port = 3000;

app.use(express.static(path.join(__dirname)));

// Proxy API requests to the backend
app.get('/api/*', async (req, res) => {
  try {
    const apiUrl = `http://localhost:5000${req.originalUrl}`;
    console.log(`Proxying request to: ${apiUrl}`);
    
    const response = await fetch(apiUrl);
    const data = await response.json();
    
    // Set the same status code as the proxied response
    res.status(response.status).json(data);
  } catch (error) {
    console.error(`Proxy error: ${error.message}`);
    res.status(500).json({ message: `Proxy error: ${error.message}` });
  }
});

app.patch('/api/*', express.json(), async (req, res) => {
  try {
    const apiUrl = `http://localhost:5000${req.originalUrl}`;
    console.log(`Proxying PATCH request to: ${apiUrl}`);
    
    const response = await fetch(apiUrl, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(req.body)
    });
    
    const data = await response.json();
    res.status(response.status).json(data);
  } catch (error) {
    console.error(`Proxy error: ${error.message}`);
    res.status(500).json({ message: `Proxy error: ${error.message}` });
  }
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'bot-token-form.html'));
});

app.listen(port, () => {
  console.log(`Bot configuration form server listening at http://localhost:${port}`);
  console.log(`Open: http://localhost:${port} in your browser to access the configuration form`);
});