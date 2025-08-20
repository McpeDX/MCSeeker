// scanner.js - Upgraded Minecraft Server Scanner
const Scanner = require('evilscan');
const status = require('minecraft-status').MinecraftServerListPing;
const mc = require('mineflayer');
const minimatch = require('minimatch');
const fs = require('fs');
const path = require('path');
const https = require('https');
const zlib = require('zlib');
const tar = require('tar-stream');
const { promisify } = require('util');
const streamPipeline = promisify(require('stream').pipeline);

// Command line args
const commandos = require('commandos');
const processParams = commandos.parse(process.argv);

// Configurable defaults
const MINECRAFT_DEFAULT_PORT = '25565-25566';
const DEFAULT_TIMEOUT = 15000; // ms
const MAX_CONCURRENCY = 256;

// Parse CLI arguments
const SCAN_OPTS_HOSTS = (processParams['ip'] || '0.0.0.0/0').toString();
const SCAN_OPTS_PORTS = (processParams['port'] || MINECRAFT_DEFAULT_PORT).toString();
const SCAN_MIN_PLAYERS = parseInt(processParams['min-players'] || 0, 10);
const SCAN_MAX_PLAYERS = processParams['max-players'] ? parseInt(processParams['max-players'], 10) : null;
const SCAN_OPTS_VERSION_FILTER = processParams['version'] || '*';
const SCAN_OPTS_CONCURRENCY = Math.min(parseInt(processParams['conc'] || MAX_CONCURRENCY, 10), 1024);
const SCAN_OPTS_OUTPUT_CSV = processParams['out'] || null;
const SCAN_OPTS_FORMAT = processParams['format'] || 'csv';
const SCAN_OPTS_LOG_DESC = !!processParams['log-desc'];
const SCAN_OPTS_SHOW_DESC = !!processParams['show-desc'];
const SCAN_OPTS_QUIET = !!processParams['quiet'];
const SCAN_OPTS_GEO_IP = !!processParams['geo-ip'];
const SCAN_OPTS_GEO_COORDS = !!processParams['geo-coords'];
const SCAN_OPTS_ENABLE_CLIENT = !!processParams['enable-client'];
const SCAN_OPTS_CLIENT_TOKEN = processParams['client-token'] || null;

// Output file stream
let outStream = null;
if (SCAN_OPTS_OUTPUT_CSV) {
  if (SCAN_OPTS_QUIET && !SCAN_OPTS_OUTPUT_CSV) {
    console.error('Error: --quiet requires --out to be set.');
    process.exit(1);
  }
  try {
    outStream = fs.createWriteStream(SCAN_OPTS_OUTPUT_CSV, { flags: 'a' });
    // Write CSV header if not exists
    const header = ['IP', 'Port', 'Version', 'Players', 'Max Players', 'Description', 'Geo'].join(',');
    if (fs.existsSync(SCAN_OPTS_OUTPUT_CSV)) {
      const content = fs.readFileSync(SCAN_OPTS_OUTPUT_CSV, 'utf8');
      if (!content.includes(header)) {
        outStream.write(header + '\n');
      }
    } else {
      outStream.write(header + '\n');
    }
  } catch (err) {
    console.error('Failed to open output file:', err.message);
    process.exit(1);
  }
}

// MaxMind GeoIP DB
let maxmindDB = null;
async function loadGeoIPDatabase() {
  const dbPath = './GeoLite2.mmdb';
  if (!fs.existsSync(dbPath)) {
    if (!processParams['maxmind-key']) {
      console.error('No MaxMind license key provided. Cannot download database.');
      process.exit(1);
    }

    console.log('Downloading GeoLite2 database...');
    const url = `https://download.maxmind.com/app/geoip_download?edition_id=GeoLite2-City&license_key=${processParams['maxmind-key']}&suffix=tar.gz`;

    const response = await new Promise((resolve, reject) => {
      https.get(url, resolve).on('error', reject);
    });

    const tarGz = response.pipe(zlib.createGunzip());
    const tarFile = fs.createWriteStream('./GeoLite2.tar');

    await streamPipeline(tarGz, tarFile);

    console.log('Downloaded tar. Extracting...');

    const extract = tar.extract();
    const dbWriteStream = fs.createWriteStream(dbPath);

    await new Promise((resolve, reject) => {
      extract.on('entry', (header, stream, next) => {
        if (header.name.match(/.*?\.mmdb$/)) {
          stream.pipe(dbWriteStream);
          dbWriteStream.on('close', resolve);
        } else {
          next();
        }
        stream.resume();
      });
      extract.on('error', reject);
      extract.on('finish', resolve);
      fs.createReadStream('./GeoLite2.tar').pipe(extract);
    });

    fs.unlinkSync('./GeoLite2.tar');
    console.log('GeoIP database extracted successfully!');
    return true;
  }

  try {
    maxmindDB = await require('maxmind').open(dbPath);
    console.log('GeoIP database loaded.');
    return true;
  } catch (err) {
    console.error('Failed to load GeoIP database:', err.message);
    return false;
  }
}

// Client token generation
let CLIENT_TOKEN = null;
async function fetchClientToken() {
  if (!SCAN_OPTS_ENABLE_CLIENT) return null;

  if (SCAN_OPTS_CLIENT_TOKEN) {
    CLIENT_TOKEN = SCAN_OPTS_CLIENT_TOKEN;
    return CLIENT_TOKEN;
  }

  console.log('Fetching free client token from TheAltening...');
  return new Promise((resolve, reject) => {
    https.get('https://api.thealtening.com/free/generate', (res) => {
      let data = [];
      res.on('data', chunk => data.push(chunk));
      res.on('end', () => {
        try {
          const body = Buffer.concat(data).toString();
          const json = JSON.parse(body);
          const token = json?.token || null;
          if (!token) {
            console.warn('No token returned from TheAltening.');
            resolve(null);
          } else {
            CLIENT_TOKEN = token;
            console.log('Token fetched:', token.substring(0, 10) + '...');
            resolve(token);
          }
        } catch (err) {
          console.error('Failed to parse token response:', err.message);
          resolve(null);
        }
      });
    }).on('error', err => {
      console.error('Token fetch failed:', err.message);
      resolve(null);
    });
  });
}

// Format description safely
function formatDescription(desc) {
  if (!desc) return '';
  const text = typeof desc === 'string' ? desc : (desc.text || '');
  return text.replace(/\n/g, ' ').replace(/,/g, ';');
}

// Log result
async function logResult(data, pingRes) {
  const ip = data.ip;
  const port = data.port;
  const version = pingRes.version.name;
  const online = pingRes.players.online;
  const max = pingRes.players.max;
  const desc = pingRes.description?.text || '';

  // Version filter
  if (!minimatch(version, SCAN_OPTS_VERSION_FILTER)) return;

  // Player count filter
  if (online < SCAN_MIN_PLAYERS) return;
  if (SCAN_MAX_PLAYERS !== null && max > SCAN_MAX_PLAYERS) return;

  // Build display text
  let displayText = `${ip}:${port}\t${version}\t${online} of ${max}`;

  if (SCAN_OPTS_SHOW_DESC) {
    displayText += `\t${mcp(desc).replace(/\n/g, ' ')}`;
  }

  // GeoIP lookup
  let geoText = '';
  if (SCAN_OPTS_GEO_IP && maxmindDB) {
    try {
      const geo = maxmindDB.get(ip);
      if (geo?.country?.iso_code) {
        geoText = geo.country.iso_code;
        if (SCAN_OPTS_GEO_COORDS) {
          geoText += ` (${geo.location.latitude}, ${geo.location.longitude})`;
        }
      }
    } catch (err) {
      console.warn(`GeoIP lookup failed for ${ip}:`, err.message);
    }
  }

  // Final output
  if (!SCAN_OPTS_QUIET) {
    const prefix = SCAN_OPTS_GEO_IP && geoText ? `[${geoText}] ` : '';
    console.log(prefix + displayText);
  }

  // CSV output
  if (SCAN_OPTS_OUTPUT_CSV) {
    let line = [ip, port, version.replace(/,/g, '+'), online, max];
    if (SCAN_OPTS_LOG_DESC) line.push(formatDescription(desc));
    if (SCAN_OPTS_GEO_IP) line.push(geoText);

    const csvLine = line.join(',');
    outStream.write(csvLine + '\n');
  }

  // Enable client connection
  if (SCAN_OPTS_ENABLE_CLIENT && (CLIENT_TOKEN || SCAN_OPTS_CLIENT_TOKEN)) {
    const token = CLIENT_TOKEN || SCAN_OPTS_CLIENT_TOKEN;
    const bot = mc.createBot({
      host: ip,
      port: port,
      token: token,
      auth: 'mojang',
      protocol: pingRes.version.protocol,
    });

    bot.once('spawn', () => {
      console.log(`Connected to ${ip}:${port} as bot.`);
    });

    bot.on('chat', (username, message) => {
      const msg = message.toString().trim();
      if (username !== bot.username) {
        console.log(`[BOT] ${username}: ${msg}`);
      }
    });

    bot.on('end', () => {
      console.log(`Disconnected from ${ip}:${port}`);
    });

    bot.on('error', err => {
      console.warn(`Bot error on ${ip}:${port}:`, err.message);
    });
  }
}

// Main scan
async function startScan() {
  console.log(`Scanning ${SCAN_OPTS_HOSTS} on ports ${SCAN_OPTS_PORTS} with ${SCAN_OPTS_CONCURRENCY} connections.`);

  const options = {
    target: SCAN_OPTS_HOSTS,
    port: SCAN_OPTS_PORTS,
    states: 'O',
    banner: false,
    concurrency: SCAN_OPTS_CONCURRENCY,
  };

  const scan = new Scanner(options);

  // Load GeoIP DB if needed
  if (SCAN_OPTS_GEO_IP) {
    await loadGeoIPDatabase();
  }

  // Fetch client token
  if (SCAN_OPTS_ENABLE_CLIENT) {
    await fetchClientToken();
  }

  scan.on('result', async (data) => {
    try {
      const pingRes = await status.ping(
        757,
        data.ip,
        data.port,
        (processParams['timeout'] || DEFAULT_TIMEOUT)
      );

      await logResult(data, pingRes);
    } catch (err) {
      // Ignore failed pings
      // console.warn(`Ping failed for ${data.ip}:${data.port}`, err.message);
    }
  });

  scan.on('error', (err) => {
    console.error('Scan error:', err.message);
  });

  scan.on('done', () => {
    console.log('✅ Scan finished!');
    if (outStream) outStream.end();
  });

  scan.run();
}

// Start scanning
startScan().catch(err => {
  console.error('Fatal error starting scan:', err.message);
  process.exit(1);
});
