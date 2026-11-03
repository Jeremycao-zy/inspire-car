// Mock Hyper3D gateway for local E2E tests (zero quota cost)
const http = require('http');
const fs = require('fs');
let lastPrompt = '';
const srv = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    if (req.url === '/rodin') {
      lastPrompt = (body.match(/name="prompt"\r\n\r\n([^\r]*)/) || [])[1] || '';
      console.log('[mock] /rodin prompt =', lastPrompt.slice(0, 120) + '...');
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ uuid: 'mock-task-001', jobs: { subscription_key: 'mock-sub' }, consumed: 1 }));
    } else if (req.url === '/status') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ jobs: [{ uuid: 'mock-task-001', status: 'Done' }] }));
    } else if (req.url === '/download') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ files: [{ url: 'http://127.0.0.1:8899/file.glb', name: 'mock.glb' }] }));
    } else if (req.url === '/file.glb') {
      res.end(fs.readFileSync('public/models/my-car.glb'));
    } else {
      res.statusCode = 404;
      res.end('{}');
    }
  });
});
srv.listen(8899, '127.0.0.1', () => console.log('mock gateway up on http://127.0.0.1:8899'));
