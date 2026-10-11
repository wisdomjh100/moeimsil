import { createServer } from 'http';
import { parse } from 'url';
import os from 'os';
import next from 'next';
import { Server } from 'socket.io';
import { attachSignaling } from './lib/signaling.js';

const dev = process.env.NODE_ENV !== 'production';
const port = Number(process.env.PORT) || 3000;
const app = next({ dev });
const handle = app.getRequestHandler();

app.prepare().then(() => {
  const httpServer = createServer((req, res) => {
    handle(req, res, parse(req.url, true));
  });
  const io = new Server(httpServer, { maxHttpBufferSize: 1e6 });
  attachSignaling(io);

  httpServer.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`포트 ${port}이 이미 사용 중이에요.`);
      process.exit(1);
    }
    throw err;
  });

  httpServer.listen(port, () => {
    console.log(`모임실 실행 중: http://localhost:${port}`);
    for (const list of Object.values(os.networkInterfaces())) {
      for (const net of list || []) {
        if (net.family === 'IPv4' && !net.internal) {
          console.log(`같은 와이파이 주소: http://${net.address}:${port}`);
        }
      }
    }
  });
});
