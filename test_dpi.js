const { execSync } = require('child_process');

const hosts = [
  'https://youtubei.googleapis.com/generate_204',
  'https://www.youtube.com',
  'https://i.ytimg.com/generate_204',
  'https://rr1---sn-jvhnu5g-c35z.googlevideo.com/generate_204'
];

const strategies = [
  '--tlsrec 1+s',
  '--tlsrec 1',
  '--tlsrec 2',
  '--split 1+s',
  '--split 1',
  '--split 2',
  '--split 1 --fake -1 --ttl 8',
  '--split 1+s --disorder 1+s'
];

console.log('Testing strategies against YouTube endpoints...');
console.log('Host order: youtubei | www.youtube | i.ytimg | googlevideo');
console.log('---------------------------------------------------------');

for (const strat of strategies) {
  try {
    try { execSync('killall ciadpi 2>/dev/null'); } catch(e){}
    execSync(`/opt/bin/ciadpi -i 127.0.0.1 -p 10805 ${strat} -D --pidfile /tmp/ciadpi.pid`);
    execSync('sleep 1');
    let results = [];
    for (const h of hosts) {
      try {
        const out = execSync(`curl -s -I --connect-timeout 2 --socks5-hostname 127.0.0.1:10805 ${h}`, { timeout: 3500 }).toString();
        const code = out.split('\n')[0].trim();
        results.push(code.includes('200') || code.includes('204') || code.includes('404') ? 'OK' : (code || 'ERR'));
      } catch(e) {
        results.push('FAIL');
      }
    }
    console.log(strat.padEnd(30), '->', results.join(' | '));
  } catch(e) {
    console.log(strat.padEnd(30), '-> START_FAILED');
  }
}
