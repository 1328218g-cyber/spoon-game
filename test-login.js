const https = require('https');

const data = JSON.stringify({
  username: '102810aa@gmail.com',
  password: '102810zing!'
});

// 여러 경로 테스트
const paths = [
  '/auth/login/',
  '/v1/users/login/',
  '/users/login/email/',
  '/auth/token/',
];

async function tryPath(path) {
  return new Promise((resolve) => {
    const options = {
      hostname: 'api.spooncast.net',
      path,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'Mozilla/5.0',
        'Origin': 'https://www.spooncast.net',
      }
    };
    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', (chunk) => body += chunk);
      res.on('end', () => {
        console.log(`${path} → ${res.statusCode}: ${body.slice(0,100)}`);
        resolve();
      });
    });
    req.on('error', () => resolve());
    req.write(data);
    req.end();
  });
}

(async () => {
  for (const p of paths) await tryPath(p);
})();
