#!/usr/bin/env node
// upnp-map-29100.mjs -- pure-Node UPnP: discover IGD, report WAN IP, map TCP 29100.
// No deps: SSDP over dgram, SOAP over http. Usage:
//   node upnp-map-29100.mjs <internal-ip> [external-port] [internal-port] [status-only|map|unmap]
import dgram from 'node:dgram';
import http from 'node:http';

const INTERNAL_IP = process.argv[2] || '192.168.0.12';
const EXT_PORT = parseInt(process.argv[3] || '29100', 10);
const INT_PORT = parseInt(process.argv[4] || process.argv[3] || '29100', 10);
const MODE = process.argv[5] || 'map'; // status-only | map | unmap

const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
let rawCount = 0;
sock.bind(0, () => { sock.setBroadcast(true); sock.setMulticastTTL(4); });

const locations = new Set();
const SSDP_ADDR = '239.255.255.250';
const SSDP_PORT = 1900;

const search = (st) => [
  'M-SEARCH * HTTP/1.1',
  `HOST: ${SSDP_ADDR}:${SSDP_PORT}`,
  'MAN: "ssdp:discover"',
  'MX: 2',
  `ST: ${st}`,
  '', ''
].join('\r\n');

const timer = setTimeout(() => sock.close(), 6000);
sock.on('message', (msg) => { rawCount++; });
sock.on('close', async () => {
  clearTimeout(timer);
  console.error(`ssdp: ${rawCount} datagrams, ${locations.size} LOCATIONs`);
  if (locations.size === 0) { console.error('NO IGD: no SSDP LOCATION seen'); process.exit(1); }
  for (const loc of locations) {
    try { await tryIgd(loc); } catch (e) { console.error(`[${loc}] ${e.message}`); }
  }
});

sock.on('message', (msg) => {
  const m = /LOCATION:\s*(.+)\r?$/im.exec(msg.toString());
  if (m) locations.add(m[1].trim());
});

for (const st of ['upnp:rootdevice', 'urn:schemas-upnp-org:device:InternetGatewayDevice:1', 'ssdp:all']) {
  sock.send(Buffer.from(search(st)), SSDP_PORT, SSDP_ADDR);
  sock.send(Buffer.from(search(st)), SSDP_PORT, '255.255.255.255'); // broadcast fallback
}

function getXml(url) {
  return new Promise((res, rej) => {
    http.get(url, { timeout: 4000 }, (r) => {
      if (r.statusCode !== 200) { r.resume(); return rej(new Error(`HTTP ${r.statusCode}`)); }
      let b = ''; r.on('data', (c) => b += c); r.on('end', () => res(b));
    }).on('error', rej);
  });
}

function soap(url, service, action, body) {
  const payload = `<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body>${body}</s:Body></s:Envelope>`;
  const u = new URL(url);
  return new Promise((res, rej) => {
    const req = http.request({
      hostname: u.hostname, port: u.port || 80, path: u.pathname + u.search, method: 'POST',
      headers: {
        'Content-Type': 'text/xml; charset="utf-8"', 'Content-Length': Buffer.byteLength(payload),
        SOAPACTION: `"${service}#${action}"`
      }, timeout: 6000
    }, (r) => {
      let b = ''; r.on('data', (c) => b += c); r.on('end', () => res({ status: r.statusCode, body: b }));
    });
    req.on('error', rej); req.on('timeout', () => req.destroy(new Error('timeout')));
    req.end(payload);
  });
}

async function tryIgd(loc) {
  const desc = await getXml(loc);
  // find every WANIPConnection/WANPPPConnection service with its controlURL
  const base = new URL(loc);
  const svcRe = /<service>([\s\S]*?)<\/service>/g;
  let svc, found = false;
  while ((svc = svcRe.exec(desc))) {
    const block = svc[1];
    const st = /<serviceType>([^<]+)<\/serviceType>/.exec(block)?.[1] || '';
    if (!/WAN(PP|IP)Connection:1/.test(st)) continue;
    let cu = /<controlURL>([^<]+)<\/controlURL>/.exec(block)?.[1] || '';
    const control = new URL(cu, base).toString();
    found = true;
    const wan = await soap(control, st, 'GetExternalIPAddress',
      `<u:GetExternalIPAddress xmlns:u="${st}"></u:GetExternalIPAddress>`);
    const wanIp = /<NewExternalIPAddress>([^<]+)<\/NewExternalIPAddress>/.exec(wan.body)?.[1];
    console.log(`IGD ${base.host} [${st.split(':').pop()}] WAN IP: ${wanIp} (status ${wan.status})`);
    if (MODE === 'status-only') return;
    if (MODE === 'map') {
      const r = await soap(control, st, 'AddPortMapping',
        `<u:AddPortMapping xmlns:u="${st}">
          <NewRemoteHost></NewRemoteHost><NewExternalPort>${EXT_PORT}</NewExternalPort>
          <NewProtocol>TCP</NewProtocol><NewInternalPort>${INT_PORT}</NewInternalPort>
          <NewInternalClient>${INTERNAL_IP}</NewInternalClient><NewEnabled>1</NewEnabled>
          <NewPortMappingDescription>epicEFI-cs-hub</NewPortMappingDescription>
          <NewLeaseDuration>0</NewLeaseDuration>
        </u:AddPortMapping>`);
      const ok = r.status === 200;
      const err = /<errorDescription>([^<]+)<\/errorDescription>/.exec(r.body)?.[1] || /<UPnPError[\s\S]*?errorCode>(\d+)</.exec(r.body)?.[1] || '';
      console.log(`map ${EXT_PORT}->${INTERNAL_IP}:${INT_PORT} TCP: ${ok ? 'OK' : `FAILED status ${r.status} ${err}`}`);
    }
    if (MODE === 'unmap') {
      const r = await soap(control, st, 'DeletePortMapping',
        `<u:DeletePortMapping xmlns:u="${st}">
          <NewRemoteHost></NewRemoteHost><NewExternalPort>${EXT_PORT}</NewExternalPort>
          <NewProtocol>TCP</NewProtocol>
        </u:DeletePortMapping>`);
      console.log(`unmap ${EXT_PORT}: ${r.status === 200 ? 'OK' : `FAILED status ${r.status}`}`);
    }
  }
  if (!found) throw new Error('no WAN connection service in description');
}
