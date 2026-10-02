import axios from 'axios';
import jwt from 'jsonwebtoken';

// This script forges an admin token, so it must never fall back to a guessable
// secret. The value that used to be hardcoded in this repository's source was
// public, which meant anyone could mint an admin session with it.
const secret = process.env.JWT_SECRET;
if (!secret || secret === 'jtg-panel-super-secret') {
  console.error(
    'JWT_SECRET must be set to your own value (at least 32 characters).\n' +
      'Example: JWT_SECRET=$(openssl rand -hex 32) npx tsx works/tests/test-api.ts'
  );
  process.exit(1);
}

const token = jwt.sign({ id: 'dev-user-klgaj6ons', role: 'admin' }, secret);

async function run() {
  const api = axios.create({ baseURL: 'http://127.0.0.1:3000/api', headers: { Authorization: `Bearer ${token}` } });
  
  try {
    const res = await api.post('/servers', {
      name: 'Test Node API', ram: 1024, port: 9006, version: '22', type: 'nodejs', nodeId: 'local'
    });
    console.log('Created:', res.data);
    
    const id = res.data.id;
    const startRes = await api.post(`/servers/${id}/start`);
    console.log('Started:', startRes.data);
    
    const statusRes = await api.get(`/servers/${id}`);
    console.log('Status:', statusRes.data.status);
    
    await new Promise(r => setTimeout(r, 2000));
    const statsRes = await api.get(`/servers/${id}/stats`);
    console.log('Stats:', statsRes.data);
    
    await api.delete(`/servers/${id}`);
    console.log('Deleted');
  } catch(e) {
    console.error(e.response ? e.response.data : e.message);
  }
}
run();
