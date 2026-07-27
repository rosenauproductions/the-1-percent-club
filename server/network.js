import os from 'os';

export const MDNS_NAME = process.env.CLUB_HOST || 'club';

export function localIpv4Addresses() {
  const ips = [];
  for (const ifaces of Object.values(os.networkInterfaces())) {
    for (const iface of ifaces ?? []) {
      if (iface.family === 'IPv4' && !iface.internal) {
        ips.push(iface.address);
      }
    }
  }
  return ips;
}

/** Prefer LAN IP — .local often fails / hangs in browsers on macOS. */
export function primaryLanBase(port) {
  const ips = localIpv4Addresses();
  if (ips.length) return `http://${ips[0]}:${port}`;
  return `http://localhost:${port}`;
}

/** Base URLs phones/TVs can use on the LAN */
export function networkBaseUrls(port) {
  const urls = [];
  const primary = primaryLanBase(port);
  urls.push(primary);

  for (const ip of localIpv4Addresses()) {
    const u = `http://${ip}:${port}`;
    if (!urls.includes(u)) urls.push(u);
  }

  const localhost = `http://localhost:${port}`;
  if (!urls.includes(localhost)) urls.push(localhost);

  // mDNS last — optional, often unreliable
  urls.push(`http://${MDNS_NAME}.local:${port}`);

  return urls;
}

export function networkInfo(port) {
  const bases = networkBaseUrls(port);
  const primary = primaryLanBase(port);
  return {
    port,
    mdnsName: MDNS_NAME,
    mdnsUrl: `http://${MDNS_NAME}.local:${port}`,
    primary,
    lanIps: localIpv4Addresses(),
    bases,
    display: `${primary}/display/`,
    host: `${primary}/host/`,
    play: `${primary}/play/`,
    qa: `${primary}/qa/`,
    links: {
      display: bases.map((b) => `${b}/display/`),
      host: bases.map((b) => `${b}/host/`),
      play: bases.map((b) => `${b}/play/`),
      qa: bases.map((b) => `${b}/qa/`),
    },
  };
}
